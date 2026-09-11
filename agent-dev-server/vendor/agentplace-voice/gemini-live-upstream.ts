/**
 * Google Gemini Live (Vertex `BidiGenerateContent`) behind the neutral provider
 * seam.
 *
 * This adapter exists because the previous approach — translating Gemini into
 * OpenAI Realtime's wire protocol — is what took Gemini out of production. A
 * translator has no way to say "this provider cannot do that", so it invented
 * roughly fourteen OpenAI event types Gemini never sends, and every invention
 * became a state the orchestrator believed in and the provider had never
 * reached. Here nothing is invented: what Gemini reports is reported, what it
 * cannot do is declared `false`, and an inference is marked as one.
 *
 * Four things about Gemini drive the whole design, and none of them survive
 * translation into a client-driven protocol:
 *
 * 1. **The server owns turn onset.** There is no `response.create`. Automatic
 *    VAD decides when the caller finished and the model answers on its own, so
 *    every turn this adapter did not itself request is reported as
 *    `unprompted` — which is the normal case, not an anomaly.
 *
 * 2. **There is no cancel.** Nothing stops a generation once it starts. That is
 *    why {@link GeminiLiveUpstreamSession.speak} refuses while the model holds
 *    the floor: a second injection cannot replace the first, it can only
 *    overlap it, which is exactly the production symptom this rewrite targets.
 *
 * 3. **The model replies to a tool result by itself** (`autoRepliesAfterTool`).
 *    An orchestrator that also asks for a reply gets two.
 *
 * 4. **Speech can only be driven by injecting text.** There are no
 *    per-response instructions, no out-of-band responses, and no
 *    `tool_choice` — `toolConfig` is absent from the Live surface entirely, and
 *    per `googleapis/python-genai` issue #468 (closed 2026-06-12 by a
 *    maintainer) that is a *backend* gap, so bypassing the SDK does not help.
 *    See `speak` for what that costs.
 *
 * ## Verified against live Vertex, 2026-08-14
 *
 * Model `gemini-live-2.5-flash-native-audio`, `us-central1`, one session, four
 * completed turns. Facts below are from that session, not from documentation:
 *
 * - `usageMetadata` **always rides in the same frame as `serverContent` with
 *   `turnComplete: true`** — it is never a standalone frame — and it is
 *   **per-turn**, not cumulative (`candidatesTokenCount` went 41 → 24 → 7 → 88;
 *   a cumulative counter cannot decrease). `totalTokenCount` equalled
 *   `promptTokenCount + candidatesTokenCount` exactly on all four turns.
 * - The output bucket is spelled **`candidatesTokenCount`**, never
 *   `responseTokenCount`, and the modality split is `candidatesTokensDetails`.
 * - `clientContent` with `role: "system"` is **honoured** on Vertex: the model
 *   recovered a pass phrase that existed only in that turn. (The AI Studio
 *   surface is documented to reject it; this adapter targets Vertex.)
 * - `realtimeInput.text` commits a user turn *and starts a generation* with no
 *   `turnComplete` flag, and the model **obeys the text as direction** rather
 *   than answering it — "Say the word READY and nothing else." produced
 *   exactly "READY.".
 * - A tool-calling turn **closes itself**: `toolCall` is followed by
 *   `turnComplete` and a billed `usageMetadata` before the client responds. The
 *   reply to a `toolResponse` is a separate, unrequested turn.
 * - Turn end is three separate frames: `outputTranscription {finished: true}`,
 *   then `generationComplete: true`, then `turnComplete: true`.
 * - `sessionResumptionUpdate` is `{newHandle, resumable}`, arrives once per
 *   completed turn, and the handle **rotates every turn** — only the latest is
 *   worth keeping.
 */
import type { RealtimeSocket } from './openai-realtime-socket.ts';
import type {
  AudioFormat,
  RealtimeCapabilities,
  RealtimeUpstream,
  RealtimeUpstreamSession,
  SpeakRequest,
  SpeechReason,
  UpstreamFact,
  UpstreamSessionConfig,
  UpstreamToolDefinition,
} from './realtime-upstream.ts';
import { PCM16_24K } from './realtime-upstream.ts';
import { negotiateAudioFormat } from './util/audio-format.ts';
import { getVoiceLogger } from './util/logger.ts';
import { isRecord } from './util/type-guards.ts';

const logger = getVoiceLogger();

export const GEMINI_LIVE_MODEL = 'gemini-live-2.5-flash-native-audio';

/**
 * Gemini's native input rate, and the only format it accepts on that leg.
 * Declared here rather than in the seam because no provider shares this *pair*
 * of constraints: OpenAI's linear PCM is 24 kHz with 8 kHz available only
 * companded, and Nova Sonic serves 8/16/24 kHz linear on both legs.
 */
export const PCM16_16K: AudioFormat = { encoding: 'pcm16', sampleRateHz: 16_000 };

/**
 * One format each way, and that is the whole list.
 *
 * There is **no G.711 on Gemini in either direction**, so a telephony leg must
 * expand µ-law/A-law to linear PCM and resample before it reaches this adapter
 * — a cost the OpenAI path does not pay, and the single biggest operational
 * difference between the two providers on a phone call.
 *
 * Google documents that other linear-PCM rates are accepted and resampled
 * server-side when the blob's mime type declares them ("the Live API will
 * resample if needed so any sample rate can be sent"). That is not declared
 * here: it is unverified on the Vertex surface, and a format wrongly advertised
 * as supported degrades into noise on a live call rather than failing at
 * `open`. Widening the list is a one-line change once someone measures it.
 */
const GEMINI_INPUT_FORMATS: readonly AudioFormat[] = Object.freeze([PCM16_16K]);
const GEMINI_OUTPUT_FORMATS: readonly AudioFormat[] = Object.freeze([PCM16_24K]);

const DEFAULT_VOICE = 'Sulafat';

/**
 * End-of-speech silence before Gemini commits the caller's turn. Google's own
 * default reads as a lull on a phone call; 500 ms is the conversational value
 * reported by Sipfront's baresip/Gemini Live deep-dive (sipfront.com, 2026-01).
 * Lower trades turn-taking speed for cutting a slow speaker off mid-sentence.
 */
export const DEFAULT_AAD_SILENCE_MS = 500;

/**
 * How many times a tool call may be refused inside one suppressed utterance.
 *
 * Gemini has no way to disable tools for a single response, so a greeting can
 * come back as a function call and no speech at all — a silent answered phone.
 * The only lever is to answer the call with a refusal, which (because the model
 * replies to every tool result by itself) makes it try again. Bounded because
 * the loop is otherwise unbounded: a model that insists costs a billed turn per
 * attempt, and a wedged conversation is worse than a tool call on a greeting,
 * so past the cap the call is reported upward for the orchestrator to answer.
 */
const MAX_TOOL_REJECTIONS = 3;

/**
 * Why injected speech was never produced. `speech_not_produced` is Gemini
 * ending the turn with nothing to show for the direction; `speech_superseded`
 * is the caller's own utterance taking the floor the direction was waiting for.
 * The orchestrator reads the code, so the two stay distinguishable.
 */
type UnspokenSpeechCode = 'speech_not_produced' | 'speech_superseded';

/** What Gemini is told when a call is refused. Steers it back to speaking. */
const TOOL_REFUSAL =
  'Tools are unavailable for this message. Reply to the caller in speech, without calling any tool.';

/** Close codes that mean the peer hung up normally rather than failed. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

/**
 * Close codes Gemini Live uses to state a reason it never sends a frame about.
 * 1007 is the context window running out mid-session — fatal, and reconnecting
 * with the same history reproduces it, which is why it is not recoverable.
 */
const CLOSE_CODE_FAULTS: Record<number, string> = {
  1007: 'context_exhausted',
  1008: 'policy_violation',
};

/** JSON-Schema keywords Gemini's `Schema` message accepts; the rest are rejected. */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'default',
  'anyOf',
  'propertyOrdering',
]);

/**
 * The measured Gemini Live position on Vertex. Every `false` here is a fact
 * about the provider that was checked, not a member left unimplemented.
 */
export const GEMINI_LIVE_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  /** No `response.create` exists. Automatic VAD decides when the model answers. */
  clientDrivenTurns: false,
  /** Nothing stops a generation. `activityStart` interrupts; the client cannot. */
  hardCancel: false,
  /** No `conversation.item.truncate`. The model's record always claims the whole utterance. */
  truncateAtPlayback: false,
  /** `systemInstruction` is fixed at setup: "You cannot update the configuration while the connection is open." */
  perResponseInstructions: false,
  /** `toolConfig` is absent from the Live surface; see the file header. */
  perResponseToolChoice: false,
  /** Every generation joins the conversation. There is no `conversation: 'none'`. */
  outOfBandResponses: false,
  /** Tools live in `setup`, which may be sent once. Changing them means reconnecting. */
  mutableTools: false,
  /** Verified live: a `toolResponse` produced an unrequested spoken turn. */
  autoRepliesAfterTool: true,
  // The tool call completes the turn, and the reply to the result is a new one.
  expectsToolResultDuringTurn: false,
  /** No speech start/stop is ever reported; what this adapter emits is inferred. */
  emitsSpeechBoundaries: false,
  canTranscribeCaller: true,
  callerNoiseReduction: false,
  /** `sessionResumption` in setup; the handle rotates each turn. */
  sessionResumption: true,
  selfNarratesToolLatency: false,
  /**
   * True: `realtimeInput.text` starts a generation with no caller turn in front
   * of it, and — verified live — the model obeys the text as direction. Only a
   * `reason: 'reply'` is refused, and that is because the server already owns
   * caller turns, not because the provider cannot be made to speak.
   */
  canSpeakUnprompted: true,
  /**
   * True, and verified rather than assumed — Nova Sonic 2 fails exactly here
   * while declaring the sibling capability, so this was measured on Vertex
   * before being declared. A session that had received no caller audio at all
   * was asked to speak: `realtimeInput.text` produced a turn 1.3 s later,
   * "READY" as text, and 5,354 bytes of audio. Gemini's turn onset waits on
   * committed input of any modality, and injected text is committed input.
   */
  canSpeakBeforeFirstInput: true,
  /**
   * True, with one half missing and one half better than expected.
   *
   * Writing works: `clientContent` seeds the live conversation mid-session, and
   * `role: "system"` is honoured on Vertex (verified — see the file header), so
   * grounding does not have to be disguised as something the caller said. That
   * matters more than it sounds: with no per-response instructions, this is the
   * ONLY channel by which screen state reaches the model before it answers a
   * caller turn, and its absence is why the translator answered every caller
   * turn blind.
   *
   * Eviction does not exist — Gemini has no delete. That is why
   * {@link GeminiLiveUpstreamSession.appendContext} always returns null: the
   * seam defines `removeContext` as valid only for ids `appendContext` handed
   * out, so issuing none makes the missing half unreachable by contract rather
   * than a silent no-op the orchestrator's ledger would trust.
   */
  mutableConversation: true,
  supportedInputFormats: GEMINI_INPUT_FORMATS,
  supportedOutputFormats: GEMINI_OUTPUT_FORMATS,
  /**
   * The connection cap, not the session cap. Google documents two clocks — an
   * audio session limited to 15 minutes and "the lifetime of a connection ...
   * limited to around 10 minutes" — and the connection one bites first.
   */
  maxSessionMs: 600_000,
});

export interface GeminiLiveUpstreamOptions {
  /** Opens one Vertex Live transport, already carrying the OAuth bearer. */
  connect(): Promise<RealtimeSocket>;
  /**
   * Full Vertex publisher resource path
   * (`projects/{p}/locations/{l}/publishers/google/models/{model}`), or
   * `models/{id}` on the AI Studio surface. Vertex rejects a bare model id.
   */
  modelResource: string;
  /** One of Google's prebuilt TTS voices; the session config may override it. */
  voice?: string;
  /** End-of-speech silence window for automatic VAD. */
  aadSilenceMs?: number;
  /**
   * Default handle from a previous session's {@link
   * GeminiLiveUpstreamSession.resumptionHandle}, to reopen with provider-side
   * state intact.
   *
   * Only a default: {@link UpstreamSessionConfig.resumptionHandle} is the seam's
   * own channel for this and takes precedence, because a handle belongs to one
   * session rather than to the upstream that opens them all — a rotator holding
   * a long-lived upstream has a different handle for every rotation and no way
   * to express that through a constructor option.
   */
  resumptionHandle?: string;
  /** Clock for caller-turn timestamps; injectable so tests are deterministic. */
  now?: () => number;
}

interface SessionDeps {
  socket: RealtimeSocket;
  config: UpstreamSessionConfig;
  onFact: (fact: UpstreamFact) => void;
  modelResource: string;
  voice: string;
  aadSilenceMs: number;
  resumptionHandle: string | null;
  inputFormat: AudioFormat;
  outputFormat: AudioFormat;
  now: () => number;
}

/**
 * One model turn. `started` is the load-bearing field: a turn requested by
 * `speak` exists locally from the moment it is asked for, but is only *started*
 * when Gemini actually produces something for it — so a request the model
 * ignored never becomes a turn the orchestrator has to reconcile.
 */
interface ModelTurn {
  id: string;
  reason: SpeechReason | 'unprompted';
  correlationId?: string;
  /** This utterance must not act; tool calls are refused up to the cap. */
  suppressTools: boolean;
  started: boolean;
  audioDone: boolean;
  transcript: string;
  toolRejections: number;
  /** A refusal is on the wire, so Gemini owes this turn another generation. */
  awaitingRetry: boolean;
}

/**
 * One caller utterance, as far as this adapter can tell.
 *
 * Gemini streams `inputTranscription` fragments and — unlike every other
 * boundary — does give a terminal (`finished: true`), which is the only
 * trustworthy delimiter. The item stays OPEN across the model's turn boundary
 * on purpose: a transcript arriving after `turnComplete` is the ASR lagging,
 * not a new utterance, and treating it as one is what made the translator
 * cancel live speech and stall its queue.
 *
 * Two ends have to be tracked separately, because they are two facts arriving
 * at different moments and each is reported once. The ASR's terminal settles
 * the TRANSCRIPT and says the caller stopped talking; the model producing
 * something is the only evidence Gemini gives that the utterance was COMMITTED
 * to the conversation. Collapsing them is what dropped both boundary facts
 * whenever the terminal arrived first: the item was closed on it, so the commit
 * had nothing left to report and the client never heard the caller stop.
 */
interface CallerItem {
  id: string;
  text: string;
  startedAt: number;
  /** The settled transcript has been reported; the ASR is done with this utterance. */
  transcriptSettled: boolean;
  /** `caller.speech.stopped` has been reported for it. */
  stopReported: boolean;
  /** `caller.turn.committed` has been reported: the model acted on it. */
  committed: boolean;
}

interface GeminiFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export class GeminiLiveUpstreamSession implements RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities = GEMINI_LIVE_CAPABILITIES;
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  #socket: RealtimeSocket;
  #onFact: (fact: UpstreamFact) => void;
  #now: () => number;
  #inputMimeType: string;
  #closed = false;
  #sessionOpenReported = false;

  #turnCounter = 0;
  #callerCounter = 0;
  #callIdCounter = 0;
  #turn: ModelTurn | null = null;
  #callerItem: CallerItem | null = null;
  #toolNameByCallId = new Map<string, string>();
  #resumptionHandle: string | null = null;

  constructor(deps: SessionDeps) {
    this.#socket = deps.socket;
    this.#onFact = deps.onFact;
    this.#now = deps.now;
    this.inputFormat = deps.inputFormat;
    this.outputFormat = deps.outputFormat;
    this.#inputMimeType = `audio/pcm;rate=${deps.inputFormat.sampleRateHz}`;

    // Handlers first: `setupComplete` can land before configuration returns.
    this.#socket.onEvent((frame) => this.#handleServerFrame(frame));
    this.#socket.onClose((code, reason) => this.#handleSocketClosed(code, reason));
    this.#socket.onError?.((error) => this.#handleSocketError(error));
    this.#socket.send({ setup: this.#buildSetup(deps) });
    this.#seedHistory(deps.config.history ?? []);
  }

  /** Caller audio in the negotiated format; the mime type states its rate. */
  sendAudio(audio: Uint8Array): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      realtimeInput: {
        audio: { data: Buffer.from(audio).toString('base64'), mimeType: this.#inputMimeType },
      },
    });
  }

  sendText(text: string, _callerItemId: string): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  /**
   * Makes the agent speak, by the only mechanism Gemini has: injecting text.
   *
   * `realtimeInput.text` commits a user turn and starts a generation, and the
   * model treats the text as direction — verified live, "Say the word READY and
   * nothing else." produced exactly "READY." rather than an answer *about* the
   * instruction. So the previous translator's
   * `[direction — do not read this aloud]` prefix was not what made this work,
   * and it is not reintroduced here. The direction goes on the wire verbatim.
   *
   * What it costs, and there is no way to avoid any of it:
   *
   * - **It pollutes the conversation permanently.** The direction is recorded
   *   as something the caller said, and Gemini has no delete, so it is in
   *   context for the rest of the session and is re-billed as prompt tokens on
   *   every subsequent turn.
   * - **It cannot be kept out of the model's history**, because out-of-band
   *   responses do not exist.
   * - **It cannot be stopped from acting.** Tools cannot be disabled per
   *   response, so a greeting may come back as a function call and silence;
   *   that is what the bounded refusal loop is for.
   *
   * Every reason except `reply` is rendered identically — `greeting`,
   * `admission`, `liveness`, `narration` and `relay` are all the same injected
   * direction with tool calls refused for the turn, because Gemini offers no
   * per-response lever to distinguish them with.
   *
   * Two requests are refused rather than degraded, both resolving null:
   *
   * - `reason: 'reply'` — always. Gemini's server already owns the answer to a
   *   caller turn (`clientDrivenTurns: false`); injecting a reply produces a
   *   *second* turn on top of the one the provider is generating, which is the
   *   overlapping-response defect that took this provider out of production.
   * - While the model holds the floor. There is no cancel, so a second
   *   injection cannot replace the utterance in flight, only talk over it.
   *   Whether to retry is scheduling policy, and the orchestrator owns it.
   *
   * `fidelity` does not change any of this: text injection speaks in the
   * model's own voice, so `model-voice-required` is satisfied whenever the
   * request is honoured at all, and no fallback synthesis happens here —
   * choosing a different voice is a decision above this seam.
   */
  async speak(request: SpeakRequest): Promise<string | null> {
    if (this.#closed) {
      return null;
    }
    if (request.reason === 'reply') {
      logger.info('[GeminiLiveUpstream] refused a reply: the server owns caller turns', {
        correlationId: request.correlationId,
      });
      return null;
    }
    if (this.#turn) {
      logger.info('[GeminiLiveUpstream] refused speech: a turn is already in flight', {
        reason: request.reason,
        activeTurnId: this.#turn.id,
      });
      return null;
    }
    if (!request.text) {
      logger.warn('[GeminiLiveUpstream] refused speech with no direction to inject', {
        reason: request.reason,
      });
      return null;
    }
    const turn = this.#startTurn(request.reason, true);
    if (request.correlationId) {
      turn.correlationId = request.correlationId;
    }
    this.#socket.send({ realtimeInput: { text: request.text } });
    return turn.id;
  }

  /**
   * Returns a tool result. No reply is requested and none can be:
   * `autoRepliesAfterTool` is true, and the model's own follow-up arrives as an
   * unprompted turn.
   */
  submitToolResult(callId: string, output: string): void {
    if (this.#closed) {
      return;
    }
    const name = this.#toolNameByCallId.get(callId);
    if (!name) {
      logger.warn('[GeminiLiveUpstream] tool result for an unknown call id', { callId });
      return;
    }
    this.#toolNameByCallId.delete(callId);
    this.#socket.send({
      toolResponse: { functionResponses: [{ id: callId, name, response: { output } }] },
    });
  }

  /**
   * Writes grounding into the live conversation. Returns null always — Gemini
   * issues no item handle, and with no delete there is nothing a handle could
   * be used for.
   *
   * `turnComplete: false` is what makes this a write rather than a question:
   * the content joins the conversation without starting a generation. `system`
   * is sent as itself because Vertex honours the role (verified live); the
   * `assistant` role is spelled `model` on this wire.
   */
  appendContext(role: 'system' | 'assistant' | 'user', text: string): string | null {
    if (this.#closed) {
      return null;
    }
    const geminiRole = role === 'assistant' ? 'model' : role;
    this.#socket.send({
      clientContent: { turns: [{ role: geminiRole, parts: [{ text }] }], turnComplete: false },
    });
    return null;
  }

  /**
   * Cannot be honoured: Gemini has no delete, and `contextWindowCompression`
   * decides on its own what leaves the window. Reachable only by an id this
   * adapter never issued, so it logs rather than pretending.
   */
  removeContext(id: string): void {
    logger.warn('[GeminiLiveUpstream] context eviction does not exist on Gemini Live', { id });
  }

  /** The newest handle Gemini has issued; they rotate once per completed turn. */
  resumptionHandle(): string | null {
    return this.#resumptionHandle;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    this.#socket.close();
    this.#emit({ type: 'session.closed', reason: 'local' });
  }

  /**
   * The one and only configuration frame: "Message to be sent in the first (and
   * only in the first) BidiGenerateContentClientMessage", and "you cannot
   * update the configuration while the connection is open" — which is the whole
   * reason `mutableTools` and `perResponseInstructions` are false.
   */
  #buildSetup(deps: SessionDeps): Record<string, unknown> {
    const setup: Record<string, unknown> = {
      model: deps.modelResource,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: deps.voice } } },
      },
      systemInstruction: { parts: [{ text: deps.config.instructions }] },
      outputAudioTranscription: {},
      // Extends the session past its 15-minute cap and is what keeps close 1007
      // rare; it does not extend the ~10-minute connection, which is separate.
      contextWindowCompression: { slidingWindow: {} },
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: deps.aadSilenceMs },
      },
      sessionResumption: deps.resumptionHandle ? { handle: deps.resumptionHandle } : {},
    };
    if (deps.config.transcription) {
      // Presence is the whole switch: Gemini's `inputAudioTranscription` takes
      // no fields, so the transcriber model, its language, and the steering
      // prompt the seam calls load-bearing for accented callers have nowhere to
      // go. Reported rather than dropped, since a surface that set them will
      // otherwise wonder why they had no effect.
      setup.inputAudioTranscription = {};
      const ignored = Object.keys(deps.config.transcription);
      if (ignored.length > 0) {
        logger.warn('[GeminiLiveUpstream] caller-transcription steering is not configurable', {
          ignored,
        });
      }
    }
    const functionDeclarations = deps.config.tools.map(toFunctionDeclaration);
    if (functionDeclarations.length > 0) {
      setup.tools = [{ functionDeclarations }];
    }
    return setup;
  }

  /** Prior conversation, oldest first, as one seeding write. */
  #seedHistory(history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>): void {
    if (history.length === 0) {
      return;
    }
    this.#socket.send({
      clientContent: {
        turns: history.map((entry) => ({
          role: entry.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: entry.text }],
        })),
        turnComplete: false,
      },
    });
  }

  #handleServerFrame(frame: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    if ('error' in frame) {
      this.#onProviderError(frame.error);
      return;
    }
    if ('setupComplete' in frame) {
      this.#reportSessionOpened();
    }
    // Usage rides with `turnComplete`, so it is read before the content that
    // ends the turn — otherwise the tokens would be reported with no turn.
    if (isRecord(frame.usageMetadata)) {
      this.#emit({ type: 'usage', turnId: this.#turn?.id ?? null, raw: frame.usageMetadata });
    }
    if (isRecord(frame.serverContent)) {
      this.#onServerContent(frame.serverContent);
    }
    if (isRecord(frame.toolCall)) {
      this.#onToolCall(frame.toolCall);
    }
    if (isRecord(frame.toolCallCancellation)) {
      this.#onToolCallCancellation(frame.toolCallCancellation);
    }
    if (isRecord(frame.goAway)) {
      this.#onGoAway(frame.goAway);
    }
    if (isRecord(frame.sessionResumptionUpdate)) {
      this.#onResumptionUpdate(frame.sessionResumptionUpdate);
    }
  }

  #reportSessionOpened(): void {
    if (this.#sessionOpenReported) {
      return;
    }
    this.#sessionOpenReported = true;
    this.#emit({ type: 'session.opened' });
  }

  #onServerContent(content: Record<string, unknown>): void {
    if (content.interrupted === true) {
      this.#onInterrupted();
      return;
    }
    if (isRecord(content.inputTranscription)) {
      this.#onCallerTranscript(content.inputTranscription);
    }
    if (isRecord(content.modelTurn)) {
      this.#onModelTurnParts(content.modelTurn.parts);
    }
    if (isRecord(content.outputTranscription)) {
      this.#onModelTranscript(content.outputTranscription);
    }
    if (content.generationComplete === true) {
      this.#emitAudioDone();
    }
    if (content.turnComplete === true) {
      this.#endTurn('completed');
    }
  }

  /**
   * Barge-in. Gemini reports one flag for two facts — the caller took the floor
   * and the generation stopped — and reports neither on its own, so the speech
   * boundary is inferred and marked as such.
   */
  #onInterrupted(): void {
    this.#emit({ type: 'caller.speech.started', confidence: 'proposed' });
    this.#endTurn('interrupted');
  }

  /**
   * Caller transcript fragments. These drive NO turn lifecycle, which is the
   * whole point: the translator derived commits and cancellations from them,
   * so a transcript arriving late cancelled live speech and stalled the queue.
   */
  #onCallerTranscript(transcription: Record<string, unknown>): void {
    const text = typeof transcription.text === 'string' ? transcription.text : '';
    const finished = transcription.finished === true;
    if (!text && (!finished || !this.#callerItem)) {
      // A terminal for an utterance that never produced a word is not an
      // utterance; opening an item for it would report speech nobody made.
      return;
    }
    const item = this.#openCallerItem();
    item.text += text;
    if (text) {
      this.#emit({
        type: 'caller.transcript',
        text,
        final: false,
        turnStartedAt: item.startedAt,
        callerItemId: item.id,
      });
    }
    if (finished) {
      this.#onCallerTranscriptFinished(item);
    }
  }

  /**
   * The ASR's own terminal for this utterance: its transcript is settled and
   * the caller has stopped talking. The item deliberately stays open — the
   * commit waits on the model acting on it — and a fragment that lags the
   * terminal therefore still belongs to it rather than opening a phantom
   * second utterance.
   */
  #onCallerTranscriptFinished(item: CallerItem): void {
    this.#settleCallerTranscript(item);
    this.#reportCallerStopped(item);
    this.#releaseSettledCallerItem(item);
  }

  #openCallerItem(): CallerItem {
    const existing = this.#callerItem;
    if (existing) {
      return existing;
    }
    this.#discardSupersededSpeech();
    this.#callerCounter += 1;
    const item: CallerItem = {
      id: `caller_${this.#callerCounter}`,
      text: '',
      startedAt: this.#now(),
      transcriptSettled: false,
      stopReported: false,
      committed: false,
    };
    this.#callerItem = item;
    // The caller is audibly speaking — we are transcribing them — but Gemini
    // never says so, so this is inference and says so.
    this.#emit({ type: 'caller.speech.started', confidence: 'proposed' });
    return item;
  }

  /**
   * The caller took the floor before injected speech reached the model. That
   * speech is gone: the answer Gemini is about to produce belongs to the
   * caller, and adopting the pending request for it would report the caller's
   * reply under the greeting's reason and correlation id.
   */
  #discardSupersededSpeech(): void {
    const turn = this.#turn;
    if (!turn || turn.started) {
      return;
    }
    this.#turn = null;
    this.#reportUnspokenTurn(
      turn,
      'speech_superseded',
      `the caller began speaking before the injected ${turn.reason} was spoken`,
    );
  }

  /**
   * Reports a turn whose injected speech will never be produced: the reason
   * first, then the turn's end.
   *
   * Both, because a fault names a turn but is not a turn-lifecycle fact. An
   * orchestrator given only the fault is still waiting on a
   * `model.turn.ended` that is never coming, and one greeting that failed to
   * produce speech then silences every later narration, relay and greeting of
   * the session.
   *
   * The turn must already be detached from `#turn` before this is called: the
   * orchestrator may request new speech synchronously from either fact, and
   * that request has to see the floor as this adapter will leave it.
   */
  #reportUnspokenTurn(turn: ModelTurn, code: UnspokenSpeechCode, message: string): void {
    this.#emit({ type: 'fault', code, message, recoverable: true, turnId: turn.id });
    this.#emitTurnEnded(turn, 'failed');
  }

  /** Emits the settled transcript for the open utterance and closes it (teardown path). */
  #finalizeCallerItem(): void {
    const item = this.#callerItem;
    if (!item) {
      return;
    }
    this.#callerItem = null;
    this.#settleCallerTranscript(item);
  }

  #settleCallerTranscript(item: CallerItem): void {
    if (item.transcriptSettled) {
      return;
    }
    item.transcriptSettled = true;
    if (!item.text) {
      return;
    }
    this.#emit({
      type: 'caller.transcript',
      text: item.text,
      final: true,
      turnStartedAt: item.startedAt,
      callerItemId: item.id,
    });
  }

  /** Inferred, and said to be: Gemini reports no speech boundary of its own. */
  #reportCallerStopped(item: CallerItem): void {
    if (item.stopReported) {
      return;
    }
    item.stopReported = true;
    this.#emit({ type: 'caller.speech.stopped', confidence: 'proposed' });
  }

  /** An utterance both settled and answered is finished; anything later is a new one. */
  #releaseSettledCallerItem(item: CallerItem): void {
    if (item.transcriptSettled && item.committed && this.#callerItem === item) {
      this.#callerItem = null;
    }
  }

  /**
   * The model producing anything is the only evidence Gemini gives that it
   * consumed the caller's utterance, so that is where the commit is reported —
   * and where a *second* model turn settles the utterance before it, since by
   * then the earlier one is definitively closed.
   */
  #commitCallerItem(): void {
    const item = this.#callerItem;
    if (!item) {
      return;
    }
    if (item.committed) {
      this.#settleCallerTranscript(item);
      this.#callerItem = null;
      return;
    }
    item.committed = true;
    this.#reportCallerStopped(item);
    this.#emit({ type: 'caller.turn.committed', callerItemId: item.id });
    this.#releaseSettledCallerItem(item);
  }

  /**
   * Whether the caller has said something Gemini has not answered yet. Content
   * the server produces in this window belongs to that utterance, whatever the
   * orchestrator asked for in the meantime.
   */
  #callerAwaitsAnswer(): boolean {
    const item = this.#callerItem;
    return item !== null && !item.committed;
  }

  /**
   * Walks EVERY part: one `serverContent` may carry audio and text at once
   * (Gemini 3.x "Server events" migration note), so reading `parts[0]` alone
   * silently drops content. `thought` parts are the model's reasoning and are
   * not speech.
   */
  #onModelTurnParts(parts: unknown): void {
    if (!Array.isArray(parts)) {
      return;
    }
    for (const part of parts) {
      if (!isRecord(part) || part.thought === true) {
        continue;
      }
      const inlineData = part.inlineData;
      if (isRecord(inlineData) && typeof inlineData.data === 'string') {
        const turn = this.#ensureTurn();
        this.#emit({
          type: 'model.audio',
          audio: Buffer.from(inlineData.data, 'base64'),
          turnId: turn.id,
        });
        continue;
      }
      if (typeof part.text === 'string' && part.text.length > 0) {
        const turn = this.#ensureTurn();
        turn.transcript += part.text;
        this.#emit({ type: 'model.text', text: part.text, turnId: turn.id, final: false });
      }
    }
  }

  #onModelTranscript(transcription: Record<string, unknown>): void {
    const text = typeof transcription.text === 'string' ? transcription.text : '';
    const finished = transcription.finished === true;
    if (!text && !finished) {
      return;
    }
    const turn = this.#ensureTurn();
    turn.transcript += text;
    if (text) {
      this.#emit({ type: 'model.text', text, turnId: turn.id, final: false });
    }
    if (finished && turn.transcript) {
      this.#emit({ type: 'model.text', text: turn.transcript, turnId: turn.id, final: true });
    }
  }

  /**
   * Tool calls Gemini asks for. On an utterance that must not act they are
   * refused instead — up to the cap, because each refusal buys another billed
   * generation and a conversation waiting on a result that never comes is worse
   * than a greeting that acts.
   */
  #onToolCall(toolCall: Record<string, unknown>): void {
    const calls = parseFunctionCalls(toolCall.functionCalls, () => this.#nextCallId());
    if (calls.length === 0) {
      return;
    }
    // Refused BEFORE the turn is opened, so the attempts the model makes on the
    // way to speaking never surface as turns of their own: one request from the
    // orchestrator stays one turn however many times Gemini reaches for a tool.
    const pending = this.#turn;
    if (pending && this.#isSuppressibleAttempt(pending)) {
      this.#refuseToolCalls(pending, calls);
      return;
    }
    const turn = this.#ensureTurn();
    if (turn.suppressTools) {
      logger.warn('[GeminiLiveUpstream] reporting a tool call on suppressed speech upward', {
        turnId: turn.id,
        rejections: turn.toolRejections,
        spoken: turn.started,
      });
    }
    for (const call of calls) {
      this.#toolNameByCallId.set(call.callId, call.name);
      this.#emit({
        type: 'tool.called',
        turnId: turn.id,
        callId: call.callId,
        name: call.name,
        args: call.args,
      });
    }
  }

  /**
   * Whether this call is one of the attempts an injected utterance makes on the
   * way to speaking — the only kind this adapter answers on the orchestrator's
   * behalf, and only up to the cap.
   *
   * A turn that has already spoken is excluded: a call made after the utterance
   * is a genuine one, and refusing it here reports nothing upward while still
   * buying the billed generation every refusal costs. So is any call arriving
   * while the caller is owed an answer — that call belongs to their turn, and
   * refusing it drops the caller's request instead of the greeting's.
   */
  #isSuppressibleAttempt(turn: ModelTurn): boolean {
    return (
      turn.suppressTools &&
      !turn.started &&
      turn.toolRejections < MAX_TOOL_REJECTIONS &&
      !this.#callerAwaitsAnswer()
    );
  }

  #refuseToolCalls(turn: ModelTurn, calls: GeminiFunctionCall[]): void {
    turn.toolRejections += 1;
    turn.awaitingRetry = true;
    logger.info('[GeminiLiveUpstream] refusing a tool call on suppressed speech', {
      turnId: turn.id,
      attempt: turn.toolRejections,
      tools: calls.map((call) => call.name),
    });
    this.#socket.send({
      toolResponse: {
        functionResponses: calls.map((call) => ({
          id: call.callId,
          name: call.name,
          response: { error: TOOL_REFUSAL },
        })),
      },
    });
  }

  /**
   * Gemini withdrew calls it had asked for — barge-in usually — and their
   * results must not be submitted. The seam has no fact for a withdrawn call,
   * so it is reported as a recoverable fault naming the turn.
   */
  #onToolCallCancellation(cancellation: Record<string, unknown>): void {
    const ids = Array.isArray(cancellation.ids)
      ? cancellation.ids.filter((id): id is string => typeof id === 'string')
      : [];
    for (const id of ids) {
      this.#toolNameByCallId.delete(id);
    }
    const fault: Extract<UpstreamFact, { type: 'fault' }> = {
      type: 'fault',
      code: 'tool_call_cancelled',
      message: `Gemini withdrew tool calls: ${ids.join(', ') || 'unnamed'}`,
      recoverable: true,
    };
    if (this.#turn) {
      fault.turnId = this.#turn.id;
    }
    this.#emit(fault);
  }

  #onGoAway(goAway: Record<string, unknown>): void {
    this.#emit({
      type: 'session.ending',
      inMs: durationToMs(goAway.timeLeft),
      resumable: this.#resumptionHandle !== null,
    });
  }

  #onResumptionUpdate(update: Record<string, unknown>): void {
    if (update.resumable === false) {
      return;
    }
    if (typeof update.newHandle === 'string' && update.newHandle) {
      this.#resumptionHandle = update.newHandle;
    }
  }

  /**
   * Opens the turn this content belongs to, on its first content. Which turn
   * that is — an injected one, or one the server decided to take — is
   * {@link GeminiLiveUpstreamSession.#adoptableTurn}'s call.
   */
  #ensureTurn(): ModelTurn {
    const turn = this.#adoptableTurn();
    if (!turn.started) {
      turn.started = true;
      turn.awaitingRetry = false;
      this.#emitTurnStarted(turn);
      this.#commitCallerItem();
    }
    return turn;
  }

  /**
   * The turn the incoming content belongs to.
   *
   * A pending `speak` is adopted for it — that is how a direction the model
   * ignored never becomes a turn that started — but NOT while the caller is
   * owed an answer. What Gemini produces then is the answer to their
   * utterance, and adopting the injected request for it reports the caller's
   * reply under a relay's reason and correlation id: the orchestrator is told
   * the relay was spoken, while the caller's own tool call is refused as one
   * that utterance must not make. The caller's utterance came first, so it
   * wins, and the injected speech is reported as superseded.
   *
   * The caller's turn is minted before the discard is reported, because the
   * orchestrator may ask to speak again from inside those facts: with a turn
   * already in flight that request is refused, rather than being adopted here
   * in place of the turn Gemini is actually taking.
   */
  #adoptableTurn(): ModelTurn {
    const pending = this.#turn;
    if (!pending) {
      return this.#startTurn('unprompted', false);
    }
    if (pending.started || !this.#callerAwaitsAnswer()) {
      return pending;
    }
    const callerTurn = this.#startTurn('unprompted', false);
    this.#reportUnspokenTurn(
      pending,
      'speech_superseded',
      `Gemini answered the caller instead of speaking the injected ${pending.reason}`,
    );
    return callerTurn;
  }

  #startTurn(reason: SpeechReason | 'unprompted', suppressTools: boolean): ModelTurn {
    this.#turnCounter += 1;
    const turn: ModelTurn = {
      id: `turn_${this.#turnCounter}`,
      reason,
      suppressTools,
      started: false,
      audioDone: false,
      transcript: '',
      toolRejections: 0,
      awaitingRetry: false,
    };
    this.#turn = turn;
    return turn;
  }

  #emitAudioDone(): void {
    const turn = this.#turn;
    if (!turn?.started || turn.audioDone) {
      return;
    }
    turn.audioDone = true;
    this.#emit({ type: 'model.audio.done', turnId: turn.id });
  }

  /**
   * Closes the turn, or keeps it when Gemini owes it another generation: a
   * refused tool call ends the turn it was made on, and the retry the refusal
   * buys arrives as a fresh one — the orchestrator asked for one utterance and
   * must see one turn, not one per attempt.
   */
  #endTurn(outcome: 'completed' | 'interrupted'): void {
    const turn = this.#turn;
    if (!turn) {
      return;
    }
    if (!turn.started) {
      this.#endUnstartedTurn(turn, outcome);
      return;
    }
    this.#emitAudioDone();
    this.#turn = null;
    this.#emitTurnEnded(turn, outcome);
  }

  /**
   * A turn that produced nothing. Under an active refusal the model still owes
   * a generation, so the turn is kept; otherwise the requested speech simply
   * did not happen, and a fault says so rather than leaving the orchestrator
   * waiting on a `model.turn.started` that is never coming.
   */
  #endUnstartedTurn(turn: ModelTurn, outcome: 'completed' | 'interrupted'): void {
    if (turn.awaitingRetry && outcome === 'completed') {
      turn.awaitingRetry = false;
      return;
    }
    this.#turn = null;
    this.#reportUnspokenTurn(
      turn,
      'speech_not_produced',
      `Gemini ended the turn without speaking the injected ${turn.reason}`,
    );
  }

  /**
   * Ends the turn in flight before the fact that the session is over goes out —
   * the model-side counterpart of the caller-side finalization every teardown
   * path already does. Without it a connection that dies mid-utterance leaves
   * the orchestrator holding a turn that never ends: masked while a closed
   * session is also a finished call, and fatal the moment something above this
   * adapter reconnects and carries that turn into the next connection.
   *
   * `failed` rather than `interrupted`, whether or not the turn ever produced
   * audio: nobody spoke over it, and an orchestrator that reads a dead
   * connection as a barge-in concludes the listener took the floor on a line
   * that has already gone silent. A retry the model still owed is not honoured
   * here either — there is no connection left to deliver it on.
   *
   * Idempotent: the turn is detached as it ends, so the close that follows a
   * transport error finds nothing left to end.
   */
  #endTurnOnTeardown(): void {
    const turn = this.#turn;
    if (!turn) {
      return;
    }
    this.#turn = null;
    if (!turn.started) {
      this.#reportUnspokenTurn(
        turn,
        'speech_not_produced',
        `the connection ended before the injected ${turn.reason} was spoken`,
      );
      return;
    }
    this.#emitTurnEnded(turn, 'failed');
  }

  #emitTurnStarted(turn: ModelTurn): void {
    this.#emit(
      turn.correlationId
        ? {
            type: 'model.turn.started',
            turnId: turn.id,
            reason: turn.reason,
            correlationId: turn.correlationId,
          }
        : { type: 'model.turn.started', turnId: turn.id, reason: turn.reason },
    );
  }

  #emitTurnEnded(turn: ModelTurn, outcome: 'completed' | 'interrupted' | 'failed'): void {
    this.#emit(
      turn.correlationId
        ? {
            type: 'model.turn.ended',
            turnId: turn.id,
            outcome,
            correlationId: turn.correlationId,
          }
        : { type: 'model.turn.ended', turnId: turn.id, outcome },
    );
  }

  /**
   * A provider error frame. The translator swallowed these entirely, which made
   * a rejected setup indistinguishable from a model that had nothing to say.
   * Reported as recoverable because the frame itself does not end the session —
   * the close that may follow is reported separately, with its own code.
   */
  #onProviderError(error: unknown): void {
    const detail = isRecord(error) ? error : {};
    const message = firstNonEmptyString(
      detail.message,
      typeof error === 'string' ? error : '',
      'Gemini Live reported an error',
    );
    const code = firstNonEmptyString(
      detail.status,
      typeof detail.code === 'number' ? String(detail.code) : '',
      'gemini_error',
    );
    const fault: Extract<UpstreamFact, { type: 'fault' }> = {
      type: 'fault',
      code,
      message,
      recoverable: true,
    };
    if (this.#turn) {
      fault.turnId = this.#turn.id;
    }
    this.#emit(fault);
  }

  /**
   * Gemini states some failures only in the close frame — a context window that
   * ran out arrives as 1007 with nothing sent beforehand — so the code is what
   * separates "the caller rang off" from "we were cut off and why".
   */
  #handleSocketClosed(code?: number, reason?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    if (code === undefined || NORMAL_CLOSE_CODES.has(code)) {
      this.#emit({ type: 'session.closed', reason: 'remote' });
      return;
    }
    this.#emit({
      type: 'fault',
      code: CLOSE_CODE_FAULTS[code] ?? `close_${code}`,
      message: reason || `Gemini Live closed the connection with code ${code}`,
      recoverable: false,
    });
    this.#emit({ type: 'session.closed', reason: 'error' });
  }

  /** A transport failure. Terminal; the close that follows is deduplicated. */
  #handleSocketError(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    this.#emit({
      type: 'fault',
      code: 'transport_error',
      message: error.message,
      recoverable: false,
    });
    this.#emit({ type: 'session.closed', reason: 'error' });
  }

  #nextCallId(): string {
    this.#callIdCounter += 1;
    return `call_${this.#callIdCounter}`;
  }

  #emit(fact: UpstreamFact): void {
    this.#onFact(fact);
  }
}

/** Opens Gemini Live sessions. One instance per configured transport. */
export class GeminiLiveUpstream implements RealtimeUpstream {
  readonly id = 'gemini-live';
  readonly capabilities: RealtimeCapabilities = GEMINI_LIVE_CAPABILITIES;

  #options: GeminiLiveUpstreamOptions;

  constructor(options: GeminiLiveUpstreamOptions) {
    this.#options = options;
  }

  async open(
    config: UpstreamSessionConfig,
    onFact: (fact: UpstreamFact) => void,
  ): Promise<GeminiLiveUpstreamSession> {
    const inputFormat = negotiateAudioFormat({
      provider: 'Gemini Live',
      direction: 'input',
      requested: config.inputFormat,
      supported: GEMINI_LIVE_CAPABILITIES.supportedInputFormats,
    });
    const outputFormat = negotiateAudioFormat({
      provider: 'Gemini Live',
      direction: 'output',
      requested: config.outputFormat,
      supported: GEMINI_LIVE_CAPABILITIES.supportedOutputFormats,
    });
    const socket = await this.#options.connect();
    return new GeminiLiveUpstreamSession({
      socket,
      config,
      onFact,
      modelResource: this.#options.modelResource,
      voice: config.voice ?? this.#options.voice ?? DEFAULT_VOICE,
      aadSilenceMs: this.#options.aadSilenceMs ?? DEFAULT_AAD_SILENCE_MS,
      resumptionHandle: config.resumptionHandle ?? this.#options.resumptionHandle ?? null,
      inputFormat,
      outputFormat,
      now: this.#options.now ?? Date.now,
    });
  }
}

/** Vertex names the model by its full publisher resource path, not its id. */
export function geminiLiveModelResource(params: {
  projectId: string;
  location: string;
  model: string;
}): string {
  return `projects/${params.projectId}/locations/${params.location}/publishers/google/models/${params.model}`;
}

function toFunctionDeclaration(tool: UpstreamToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.parameters),
  };
}

/**
 * Strips JSON-Schema keywords Gemini's `Schema` message rejects. Gemini refuses
 * the whole setup over one unknown keyword, so an unfiltered schema is a
 * session that never opens.
 */
export function sanitizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeToolSchema(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'properties' && isRecord(entry)) {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(entry)) {
        properties[name] = sanitizeToolSchema(schema);
      }
      sanitized[key] = properties;
      continue;
    }
    if (key === 'items' || key === 'anyOf') {
      sanitized[key] = sanitizeToolSchema(entry);
      continue;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

function parseFunctionCalls(value: unknown, mintId: () => string): GeminiFunctionCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: GeminiFunctionCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      continue;
    }
    calls.push({
      callId: typeof entry.id === 'string' && entry.id ? entry.id : mintId(),
      name: entry.name,
      // Gemini sends arguments as a decoded object, not the JSON string OpenAI
      // uses, so there is nothing to parse and nothing that can fail to parse.
      args: isRecord(entry.args) ? entry.args : {},
    });
  }
  return calls;
}

/**
 * Protobuf `Duration` in JSON is a seconds string (`"60s"`), but the Vertex
 * surface has also been seen sending the message form.
 */
function durationToMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const seconds = Number.parseFloat(value.endsWith('s') ? value.slice(0, -1) : value);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  }
  if (isRecord(value)) {
    const seconds = typeof value.seconds === 'number' ? value.seconds : 0;
    const nanos = typeof value.nanos === 'number' ? value.nanos : 0;
    return Math.round(seconds * 1000 + nanos / 1_000_000);
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}
