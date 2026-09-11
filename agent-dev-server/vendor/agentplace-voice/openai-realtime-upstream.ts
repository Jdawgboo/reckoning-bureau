/**
 * OpenAI Realtime (`gpt-realtime-2.1`) behind the neutral provider seam.
 *
 * This is the reference adapter: OpenAI's wire protocol used to *be* this
 * library's internal vocabulary, so implementing it against {@link
 * RealtimeUpstream} is the proof that the seam can express everything the
 * session manager does today — out-of-band responses, per-response
 * instructions, `tool_choice: 'none'`, hard cancel, playback truncation, and a
 * conversation the orchestrator can write to and evict from mid-session.
 *
 * Three things here are deliberate and are the reason this file exists rather
 * than a thin `send(event)` passthrough:
 *
 * 1. **Turn identity is minted locally, never borrowed from the provider.**
 *    A provider `response` is not a turn: it can be rejected before it ever
 *    exists, it can arrive after the orchestrator has moved on, and a late
 *    `response.done` that retargets "the current turn" is exactly how one
 *    caller question turned into five overlapping answers in production. Every
 *    turn gets an id at request time, is carried on the wire as the client
 *    `event_id` and as `response.metadata.turn_id`, and is bound to the
 *    provider's `response.id` only once the provider acknowledges it.
 *    Abandoned turns go into a discarded set and their content facts are
 *    dropped instead of being handed to an orchestrator that no longer wants
 *    them. (Same shape as LiveKit's `client_event_id` + `_discarded_event_ids`.)
 *
 * 2. **Usage is passed through verbatim.** Which token buckets are billable,
 *    and how modalities nest inside them, is the billing layer's model. A
 *    previous reduction at this seam dropped the modality detail and billed
 *    audio minutes at text rates.
 *
 * 3. **Audio is passed through in the negotiated format, never converted.**
 *    OpenAI accepts linear PCM at 24 kHz only; its 8 kHz support is G.711
 *    companded audio, in both companding laws
 *    (https://developers.openai.com/api/docs/guides/realtime — "PCM audio at a
 *    24kHz sample rate, as well as G.711 μ-law and A-law"). Because the format
 *    is negotiated at `open`, caller audio already arrives in the shape the
 *    provider wants and model audio leaves in the shape the caller asked for,
 *    so a European phone leg holding A-law spends nothing on conversion — which
 *    is the whole reason the format, and not merely the rate, is negotiable.
 *    `util/g711.ts` holds the companding helpers for a caller whose own source
 *    format differs from the leg it negotiated.
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
import { G711_ALAW, G711_ULAW, PCM16_24K } from './realtime-upstream.ts';
import { negotiateAudioFormat } from './util/audio-format.ts';
import { getVoiceLogger } from './util/logger.ts';
import { isRecord } from './util/type-guards.ts';

const logger = getVoiceLogger();

export const OPENAI_REALTIME_MODEL = 'gpt-realtime-2.1';

/**
 * Every format OpenAI Realtime serves, most preferred first: linear PCM16 at
 * 24 kHz for browser audio, then both G.711 laws at 8 kHz for telephony. The
 * same list applies in each direction.
 */
const OPENAI_AUDIO_FORMATS: readonly AudioFormat[] = Object.freeze([
  PCM16_24K,
  G711_ULAW,
  G711_ALAW,
]);

const OPENAI_FORMAT_TYPES: Record<AudioFormat['encoding'], string> = {
  pcm16: 'audio/pcm',
  'g711-ulaw': 'audio/pcmu',
  'g711-alaw': 'audio/pcma',
};

/** Prefixes a context write's client event id, so a fault about it is attributable. */
const CONTEXT_EVENT_PREFIX = 'ctxop:';
/** Correlates a truncate request with the ack or error the provider answers it with. */
const TRUNCATE_EVENT_PREFIX = 'trunc:';

const DEFAULT_VOICE = 'marin';

/**
 * Turns whose audio item is still remembered for {@link
 * OpenAiRealtimeUpstreamSession.truncate}. Barge-in usually lands *after*
 * `response.done` — generation finishes long before the listener has heard the
 * tail — so the item id has to outlive the turn it belongs to.
 */
const MAX_TRACKED_AUDIO_ITEMS = 8;

/**
 * The measured OpenAI Realtime position. Every flag is a fact about the
 * provider; nothing here is a preference or a fallback.
 *
 * `autoRepliesAfterTool: false` is the one that inverts against Gemini and
 * Nova Sonic: OpenAI returns to idle after a `function_call_output` and waits
 * to be asked, so an orchestrator that assumes an automatic reply gets silence
 * — and one that drives a reply on a provider that already replied gets two.
 */
export const OPENAI_REALTIME_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  clientDrivenTurns: true,
  hardCancel: true,
  truncateAtPlayback: true,
  perResponseInstructions: true,
  perResponseToolChoice: true,
  outOfBandResponses: true,
  mutableTools: true,
  autoRepliesAfterTool: false,
  // A function call ends the response; the result belongs to the next one.
  expectsToolResultDuringTurn: false,
  emitsSpeechBoundaries: true,
  canTranscribeCaller: true,
  callerNoiseReduction: true,
  sessionResumption: false,
  selfNarratesToolLatency: false,
  /** `response.create` needs no caller turn in front of it, so speech is always available. */
  canSpeakUnprompted: true,
  /**
   * True: `response.create` generates from the session's instructions and
   * whatever conversation exists, and an empty input audio buffer is not a
   * precondition it consults. The greeting this gateway has always opened
   * sessions with is that call, made before a caller says anything.
   */
  canSpeakBeforeFirstInput: true,
  mutableConversation: true,
  supportedInputFormats: OPENAI_AUDIO_FORMATS,
  supportedOutputFormats: OPENAI_AUDIO_FORMATS,
  /** UNVERIFIED: carried over from the brief, not confirmed against live docs. */
  maxSessionMs: 3_600_000,
});

export interface OpenAiRealtimeUpstreamOptions {
  /** Opens one realtime transport. Production passes `connectOpenAiRealtime`; tests pass a double. */
  connect(): Promise<RealtimeSocket>;
  /** Prebuilt OpenAI voice used when the session config names none. */
  voice?: string;
  /** Clock for caller-turn timestamps; injectable so tests are deterministic. */
  now?: () => number;
}

interface SessionDeps {
  socket: RealtimeSocket;
  config: UpstreamSessionConfig;
  onFact: (fact: UpstreamFact) => void;
  voice: string;
  inputFormat: AudioFormat;
  outputFormat: AudioFormat;
  now: () => number;
}

interface AudioItemRef {
  itemId: string;
  contentIndex: number;
}

interface FunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

type ContextRole = 'system' | 'assistant' | 'user';

/** Close codes that mean the peer hung up normally rather than failed. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

/** `response.status` values that mean the turn was stopped rather than finished. */
const INTERRUPTED_STATUSES = new Set(['cancelled', 'incomplete']);

export class OpenAiRealtimeUpstreamSession implements RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities = OPENAI_REALTIME_CAPABILITIES;
  /** What `open` settled on, defaults included — the shape `sendAudio` and `model.audio` carry. */
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  #socket: RealtimeSocket;
  #onFact: (fact: UpstreamFact) => void;
  #voice: string;
  #now: () => number;
  #tools: UpstreamToolDefinition[];
  #closed = false;
  #sessionOpenReported = false;

  #turnCounter = 0;
  #contextCounter = 0;
  /** Turns whose `response.create` is on the wire but which the provider has not acknowledged. */
  #pendingTurnIds: string[] = [];
  #reasonByTurnId = new Map<string, SpeechReason | 'unprompted'>();
  #correlationByTurnId = new Map<string, string>();
  #turnIdByResponseId = new Map<string, string>();
  #responseIdByTurnId = new Map<string, string>();
  #audioItemByTurnId = new Map<string, AudioItemRef>();
  /** Turns the orchestrator abandoned. Their content facts are dropped; their usage is not. */
  #discardedTurnIds = new Set<string>();
  /** Caller turn start per provider item id, so interleaved transcripts keep their own clock. */
  #callerTurnStartedAt = new Map<string, number>();

  constructor(deps: SessionDeps) {
    this.#socket = deps.socket;
    this.#onFact = deps.onFact;
    this.inputFormat = deps.inputFormat;
    this.outputFormat = deps.outputFormat;
    this.#voice = deps.config.voice ?? deps.voice;
    this.#now = deps.now;
    this.#tools = [...deps.config.tools];

    // Handlers first: a `session.created` that arrives while we are still
    // writing configuration must not be the one event we miss.
    this.#socket.onEvent((event) => this.#handleEvent(event));
    this.#socket.onClose((code, reason) => this.#handleSocketClosed(code, reason));
    this.#socket.onError?.((error) => this.#handleSocketError(error));
    this.#configure(deps.config);
    this.#seedHistory(deps.config.history ?? []);
  }

  /**
   * Caller audio in the negotiated input format, forwarded byte for byte. A
   * telephony leg that already holds companded audio pays nothing here; a
   * caller whose source format differs converts before this call, using
   * `util/g711.ts`, because only it knows what it is holding.
   */
  sendAudio(audio: Uint8Array): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64'),
    });
  }

  sendText(text: string, callerItemId: string): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      type: 'conversation.item.create',
      item: {
        id: callerItemId,
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /**
   * OpenAI can always be driven, so `fidelity` never forces a degraded
   * rendering here and the only refusal is a closed session. Every reason other
   * than `reply` goes out-of-band (`conversation: 'none'`, tools off) and is
   * rendered identically — `greeting`, `admission`, `progress`, `liveness`,
   * `narration` and `relay` differ only in the direction supplied as `text`:
   * none of them may persist as conversation the model will later replay, and
   * none of them may act.
   *
   * No queueing: whether a second request should wait for the response in
   * flight, be dropped, or preempt it is scheduling policy the orchestrator
   * owns. A rejected create surfaces as a `fault` naming this turn id.
   */
  async speak(request: SpeakRequest): Promise<string | null> {
    if (this.#closed) {
      return null;
    }
    const turnId = this.#mintTurn(request.reason);
    if (request.correlationId) {
      this.#correlationByTurnId.set(turnId, request.correlationId);
    }
    this.#pendingTurnIds.push(turnId);
    this.#socket.send({
      type: 'response.create',
      event_id: turnId,
      response: this.#responseFor(turnId, request),
    });
    return turnId;
  }

  /** No reply follows: `autoRepliesAfterTool` is false, so the orchestrator must ask for one. */
  submitToolResult(callId: string, output: string): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
  }

  /**
   * Writes an item into the live conversation and returns its id — OpenAI
   * accepts a client-chosen `item.id`, so the handle is the one we sent rather
   * than one we have to wait for.
   *
   * Assistant items reject `input_text` and user/system items reject
   * `output_text`; getting that pairing wrong is rejected by the provider, not
   * silently ignored.
   */
  appendContext(role: ContextRole, text: string): string | null {
    if (this.#closed) {
      return null;
    }
    this.#contextCounter += 1;
    const id = `ctx_${this.#contextCounter}`;
    const contentType = role === 'assistant' ? 'output_text' : 'input_text';
    this.#socket.send({
      type: 'conversation.item.create',
      event_id: `${CONTEXT_EVENT_PREFIX}${id}`,
      item: { id, type: 'message', role, content: [{ type: contentType, text }] },
    });
    return id;
  }

  /**
   * A delete that races the provider having already dropped the item comes back
   * as an ordinary `error`. It is reported rather than swallowed — the
   * orchestrator owns the ledger and is the only layer that can tell its own
   * eviction from a real problem — but the fault names the item, so telling
   * them apart is a comparison rather than a search through prose.
   */
  removeContext(id: string): void {
    if (this.#closed) {
      return;
    }
    this.#socket.send({
      type: 'conversation.item.delete',
      event_id: `${CONTEXT_EVENT_PREFIX}${id}`,
      item_id: id,
    });
  }

  /**
   * A cancel is always addressed to a specific response. When the turn has not
   * been acknowledged yet there is nothing to address, so the cancel is held
   * and sent the moment the provider names the response — a bare
   * `response.cancel` at this point would stop whatever else happens to be
   * speaking, which is the misattribution this adapter exists to prevent.
   */
  cancel(turnId: string): void {
    if (this.#closed || !this.#reasonByTurnId.has(turnId)) {
      return;
    }
    this.#discardedTurnIds.add(turnId);
    const responseId = this.#responseIdByTurnId.get(turnId);
    if (!responseId) {
      logger.info('[OpenAiRealtimeUpstream] cancel held until the turn is acknowledged', {
        turnId,
      });
      return;
    }
    this.#socket.send({ type: 'response.cancel', response_id: responseId });
  }

  /** Trims the model's record of its own audio to what the listener actually heard. */
  truncate(turnId: string, playedMs: number): void {
    if (this.#closed) {
      return;
    }
    const audioItem = this.#audioItemByTurnId.get(turnId);
    if (!audioItem) {
      logger.warn('[OpenAiRealtimeUpstream] truncate for a turn with no observed audio', {
        turnId,
      });
      return;
    }
    this.#socket.send({
      // The event_id is what makes the answer attributable: success comes back
      // as `conversation.item.truncated` naming the item, and a refusal as an
      // `error` naming this event — without it a failed trim is just another
      // anonymous provider error.
      event_id: `${TRUNCATE_EVENT_PREFIX}${turnId}`,
      type: 'conversation.item.truncate',
      item_id: audioItem.itemId,
      content_index: audioItem.contentIndex,
      audio_end_ms: Math.max(0, Math.round(playedMs)),
    });
  }

  setTools(tools: UpstreamToolDefinition[]): void {
    if (this.#closed) {
      return;
    }
    this.#tools = [...tools];
    this.#socket.send({
      type: 'session.update',
      session: { type: 'realtime', tools: this.#tools.map(toOpenAiTool) },
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#endInFlightTurns();
    this.#socket.close();
    this.#emit({ type: 'session.closed', reason: 'local' });
  }

  #configure(config: UpstreamSessionConfig): void {
    const input: Record<string, unknown> = {
      format: toOpenAiFormat(this.inputFormat),
      // `create_response: false` is structural, not tuning: turn onset belongs
      // to the orchestrator (`clientDrivenTurns`), and a provider that also
      // replies on its own produces a second, unowned turn.
      turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: false },
      noise_reduction: { type: config.callerAudio?.noiseReduction ?? 'near_field' },
    };
    if (config.transcription) {
      // Verbatim, including `prompt`: the steering text is what stops an
      // accented caller being transcribed into the wrong language, and an
      // adapter-side default would silently override the surface's own.
      input.transcription = { ...config.transcription };
    }
    this.#socket.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: config.instructions,
        output_modalities: ['audio'],
        audio: {
          input,
          output: { format: toOpenAiFormat(this.outputFormat), voice: this.#voice },
        },
        tools: this.#tools.map(toOpenAiTool),
      },
    });
  }

  #seedHistory(history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>): void {
    for (const entry of history) {
      const contentType = entry.role === 'user' ? 'input_text' : 'output_text';
      this.#socket.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: entry.role,
          content: [{ type: contentType, text: entry.text }],
        },
      });
    }
  }

  #responseFor(turnId: string, request: SpeakRequest): Record<string, unknown> {
    const metadata: Record<string, string> = { kind: request.reason, turn_id: turnId };
    if (request.correlationId) {
      metadata.correlation_id = request.correlationId;
    }
    const response: Record<string, unknown> = { metadata };
    if (request.text) {
      response.instructions = request.text;
    }
    if (request.reason !== 'reply') {
      response.conversation = 'none';
      response.tool_choice = 'none';
      response.output_modalities = ['audio'];
    }
    return response;
  }

  #mintTurn(reason: SpeechReason | 'unprompted'): string {
    this.#turnCounter += 1;
    const turnId = `turn_${this.#turnCounter}`;
    this.#reasonByTurnId.set(turnId, reason);
    return turnId;
  }

  #handleEvent(event: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'session.created':
      case 'session.updated':
        this.#reportSessionOpened();
        return;
      case 'input_audio_buffer.speech_started':
        this.#onCallerSpeechStarted(event);
        return;
      case 'input_audio_buffer.speech_stopped':
        this.#emit({ type: 'caller.speech.stopped', confidence: 'reported' });
        return;
      case 'input_audio_buffer.committed':
        this.#onCallerTurnCommitted(event);
        return;
      case 'conversation.item.input_audio_transcription.delta':
        this.#onCallerTranscript(event, false);
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.#onCallerTranscript(event, true);
        return;
      case 'response.created':
        this.#onResponseCreated(event);
        return;
      case 'response.output_audio.delta':
        this.#onOutputAudioDelta(event);
        return;
      case 'response.output_audio.done':
        this.#onOutputAudioDone(event);
        return;
      case 'response.output_audio_transcript.delta':
        this.#onOutputTranscript(event, false);
        return;
      case 'response.output_audio_transcript.done':
        this.#onOutputTranscript(event, true);
        return;
      case 'response.done':
        this.#onResponseDone(event);
        return;
      case 'conversation.item.truncated':
        this.#onItemTruncated(event);
        return;
      case 'error':
        this.#onProviderError(event);
        return;
      default:
        return;
    }
  }

  #reportSessionOpened(): void {
    if (this.#sessionOpenReported) {
      return;
    }
    this.#sessionOpenReported = true;
    this.#emit({ type: 'session.opened' });
  }

  #onCallerSpeechStarted(event: Record<string, unknown>): void {
    this.#callerTurnStartedAt.set(stringField(event, 'item_id'), this.#now());
    this.#emit({ type: 'caller.speech.started', confidence: 'reported' });
  }

  #onCallerTurnCommitted(event: Record<string, unknown>): void {
    const callerItemId = stringField(event, 'item_id');
    this.#emit(
      callerItemId
        ? { type: 'caller.turn.committed', callerItemId }
        : { type: 'caller.turn.committed' },
    );
  }

  #onCallerTranscript(event: Record<string, unknown>, final: boolean): void {
    const callerItemId = stringField(event, 'item_id');
    const text = final ? stringField(event, 'transcript') : stringField(event, 'delta');
    let turnStartedAt = this.#callerTurnStartedAt.get(callerItemId);
    if (turnStartedAt === undefined) {
      turnStartedAt = this.#now();
      this.#callerTurnStartedAt.set(callerItemId, turnStartedAt);
    }
    if (final) {
      this.#callerTurnStartedAt.delete(callerItemId);
    }
    this.#emit(
      callerItemId
        ? { type: 'caller.transcript', text, final, turnStartedAt, callerItemId }
        : { type: 'caller.transcript', text, final, turnStartedAt },
    );
  }

  /**
   * Binds the provider's response to a locally minted turn. The provider echoes
   * `metadata`, so that is the exact binding; the pending queue covers a
   * provider that drops it, and anything left over is a response we did not ask
   * for — reported as `unprompted` rather than attributed to a turn of ours.
   */
  #onResponseCreated(event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    const turnId = this.#bindTurn(response);
    const responseId = stringField(response, 'id');
    if (responseId) {
      this.#turnIdByResponseId.set(responseId, turnId);
      this.#responseIdByTurnId.set(turnId, responseId);
    }
    if (this.#discardedTurnIds.has(turnId) && responseId) {
      logger.info('[OpenAiRealtimeUpstream] cancelling a turn abandoned before it started', {
        turnId,
      });
      this.#socket.send({ type: 'response.cancel', response_id: responseId });
    }
    this.#emitTurnStarted(turnId, this.#reasonByTurnId.get(turnId) ?? 'unprompted');
  }

  #bindTurn(response: Record<string, unknown>): string {
    const tagged = this.#turnIdFromMetadata(response);
    if (tagged) {
      this.#pendingTurnIds = this.#pendingTurnIds.filter((id) => id !== tagged);
      return tagged;
    }
    const pending = this.#pendingTurnIds.shift();
    if (pending) {
      return pending;
    }
    return this.#mintTurn('unprompted');
  }

  #turnIdFromMetadata(response: Record<string, unknown>): string | null {
    if (!isRecord(response.metadata)) {
      return null;
    }
    const turnId = stringField(response.metadata, 'turn_id');
    if (!turnId || !this.#reasonByTurnId.has(turnId)) {
      return null;
    }
    return turnId;
  }

  #onOutputAudioDelta(event: Record<string, unknown>): void {
    const turnId = this.#turnIdByResponseId.get(stringField(event, 'response_id'));
    if (!turnId) {
      return;
    }
    this.#rememberAudioItem(turnId, event);
    if (this.#discardedTurnIds.has(turnId)) {
      return;
    }
    // Byte-for-byte in the negotiated output format; see `sendAudio`.
    const audio = Buffer.from(stringField(event, 'delta'), 'base64');
    this.#emit({ type: 'model.audio', audio, turnId });
  }

  #onOutputAudioDone(event: Record<string, unknown>): void {
    const turnId = this.#turnIdByResponseId.get(stringField(event, 'response_id'));
    if (!turnId || this.#discardedTurnIds.has(turnId)) {
      return;
    }
    this.#emit({ type: 'model.audio.done', turnId });
  }

  #rememberAudioItem(turnId: string, event: Record<string, unknown>): void {
    if (this.#audioItemByTurnId.has(turnId)) {
      return;
    }
    const itemId = stringField(event, 'item_id');
    if (!itemId) {
      return;
    }
    const contentIndex = typeof event.content_index === 'number' ? event.content_index : 0;
    this.#audioItemByTurnId.set(turnId, { itemId, contentIndex });
    if (this.#audioItemByTurnId.size > MAX_TRACKED_AUDIO_ITEMS) {
      const oldest = this.#audioItemByTurnId.keys().next();
      if (!oldest.done) {
        this.#audioItemByTurnId.delete(oldest.value);
      }
    }
  }

  #onOutputTranscript(event: Record<string, unknown>, final: boolean): void {
    const turnId = this.#turnIdByResponseId.get(stringField(event, 'response_id'));
    if (!turnId || this.#discardedTurnIds.has(turnId)) {
      return;
    }
    const text = final ? stringField(event, 'transcript') : stringField(event, 'delta');
    this.#emit({ type: 'model.text', text, turnId, final });
  }

  /**
   * Usage is reported for every response, including one the orchestrator
   * abandoned — the tokens were spent whether or not the listener heard them.
   * Tool calls are reported only for turns still wanted.
   */
  #onResponseDone(event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    const turnId = this.#resolveTurnId(response);
    if (isRecord(response.usage)) {
      this.#emit({ type: 'usage', turnId, raw: response.usage });
    }
    if (!turnId) {
      logger.warn('[OpenAiRealtimeUpstream] response.done for an unbound response', {
        responseId: stringField(response, 'id'),
      });
      return;
    }
    const status = stringField(response, 'status');
    this.#reportResponseFailure(response, status, turnId);
    if (!this.#discardedTurnIds.has(turnId)) {
      for (const call of functionCallsOf(response)) {
        this.#emit({
          type: 'tool.called',
          turnId,
          callId: call.callId,
          name: call.name,
          args: call.args,
        });
      }
    }
    this.#emitTurnEnded(turnId, outcomeOf(status));
    this.#forgetTurn(turnId);
  }

  /**
   * `outcome: 'failed'` says the turn did not produce what it was asked for;
   * this says why. Both are needed — the outcome is what the orchestrator
   * branches on, the fault is what a human reads in the logs.
   */
  #reportResponseFailure(response: Record<string, unknown>, status: string, turnId: string): void {
    if (status !== 'failed') {
      return;
    }
    const details = isRecord(response.status_details) ? response.status_details : {};
    const error = isRecord(details.error) ? details.error : {};
    this.#emit({
      type: 'fault',
      code: firstNonEmptyString(error.code, error.type, 'response_failed'),
      message: firstNonEmptyString(error.message, 'response failed'),
      recoverable: true,
      turnId,
    });
  }

  #resolveTurnId(response: Record<string, unknown>): string | null {
    const byResponseId = this.#turnIdByResponseId.get(stringField(response, 'id'));
    if (byResponseId) {
      return byResponseId;
    }
    return this.#turnIdFromMetadata(response);
  }

  #emitTurnStarted(turnId: string, reason: SpeechReason | 'unprompted'): void {
    const correlationId = this.#correlationByTurnId.get(turnId);
    this.#emit(
      correlationId
        ? { type: 'model.turn.started', turnId, reason, correlationId }
        : { type: 'model.turn.started', turnId, reason },
    );
  }

  #emitTurnEnded(turnId: string, outcome: 'completed' | 'interrupted' | 'failed'): void {
    const correlationId = this.#correlationByTurnId.get(turnId);
    this.#emit(
      correlationId
        ? { type: 'model.turn.ended', turnId, outcome, correlationId }
        : { type: 'model.turn.ended', turnId, outcome },
    );
  }

  #forgetTurn(turnId: string): void {
    const responseId = this.#responseIdByTurnId.get(turnId);
    if (responseId) {
      this.#turnIdByResponseId.delete(responseId);
    }
    this.#responseIdByTurnId.delete(turnId);
    this.#reasonByTurnId.delete(turnId);
    this.#correlationByTurnId.delete(turnId);
    this.#discardedTurnIds.delete(turnId);
  }

  /**
   * Provider `error` events do not end the session — the connection closing
   * does — so every one of them is reported as recoverable. The exception is
   * `session_expired`, which is the provider stating the session is over rather
   * than reporting a problem with a request.
   *
   * `error.event_id` echoes the client event that caused it, which is why every
   * `response.create` carries its turn id there: a rejected create is the one
   * case where a turn we minted will never exist, and naming it in the fault is
   * what lets the orchestrator requeue that exact intent.
   */
  /** The provider's conversation now ends where the listener stopped hearing. */
  #onItemTruncated(event: Record<string, unknown>): void {
    const itemId = stringField(event, 'item_id');
    for (const [turnId, audioItem] of this.#audioItemByTurnId) {
      if (audioItem.itemId === itemId) {
        this.#emit({ type: 'context.truncated', turnId });
        return;
      }
    }
  }

  #onProviderError(event: Record<string, unknown>): void {
    const error = isRecord(event.error) ? event.error : {};
    const causeEventId = stringField(error, 'event_id');
    const code = firstNonEmptyString(error.code, error.type, 'unknown_error');
    if (code === 'session_expired') {
      this.#emit({ type: 'session.ending', inMs: 0, resumable: false });
      return;
    }
    const fault: Extract<UpstreamFact, { type: 'fault' }> = {
      type: 'fault',
      code,
      message: firstNonEmptyString(error.message, code),
      recoverable: true,
    };
    const rejectedTurnId = this.#dropPendingTurn(causeEventId);
    if (rejectedTurnId) {
      fault.turnId = rejectedTurnId;
    }
    if (causeEventId.startsWith(CONTEXT_EVENT_PREFIX)) {
      fault.contextId = causeEventId.slice(CONTEXT_EVENT_PREFIX.length);
    }
    if (causeEventId.startsWith(TRUNCATE_EVENT_PREFIX)) {
      fault.code = 'truncate_failed';
      fault.turnId = causeEventId.slice(TRUNCATE_EVENT_PREFIX.length);
    }
    this.#emit(fault);
  }

  /** Returns the turn the provider rejected, when the failing event named one. */
  #dropPendingTurn(causeEventId: string): string | null {
    if (!causeEventId || !this.#pendingTurnIds.includes(causeEventId)) {
      return null;
    }
    this.#pendingTurnIds = this.#pendingTurnIds.filter((id) => id !== causeEventId);
    logger.warn('[OpenAiRealtimeUpstream] turn rejected before it started', {
      turnId: causeEventId,
    });
    this.#forgetTurn(causeEventId);
    return causeEventId;
  }

  /**
   * Ends every turn this session still owes an ending, before the fact that the
   * session is over goes out. Without it a connection that dies mid-utterance
   * leaves the orchestrator holding a turn that never ends — masked while a
   * closed session is also a finished call, and fatal the moment something above
   * this adapter reconnects and carries that turn into the next connection.
   *
   * Both kinds are ended: a turn the provider acknowledged, and one whose
   * `response.create` is still unanswered — an unanswered create is a turn that
   * will now never exist, and the orchestrator is waiting on it either way.
   *
   * `failed` rather than `interrupted`: nobody spoke over these turns, and an
   * orchestrator that reads a dead connection as a barge-in concludes the
   * listener took the floor on a line that has already gone silent.
   *
   * Idempotent — the bookkeeping is cleared as it goes, so the close that
   * follows a transport error finds nothing left to end.
   */
  #endInFlightTurns(): void {
    this.#pendingTurnIds = [];
    for (const turnId of [...this.#reasonByTurnId.keys()]) {
      this.#emitTurnEnded(turnId, 'failed');
      this.#forgetTurn(turnId);
    }
  }

  /**
   * The provider hung up. An abnormal close code is reported as a fault first,
   * because some refusals are stated only in the close frame — a session the
   * far end declines after accepting the connection arrives as a code and a
   * reason with no error event in front of it, and swallowing both leaves the
   * listener's client opening and closing having said nothing.
   */
  #handleSocketClosed(code?: number, reason?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#endInFlightTurns();
    if (code === undefined || NORMAL_CLOSE_CODES.has(code)) {
      this.#emit({ type: 'session.closed', reason: 'remote' });
      return;
    }
    this.#emit({
      type: 'fault',
      code: `close_${code}`,
      message: reason || `the connection closed with code ${code}`,
      recoverable: false,
    });
    this.#emit({ type: 'session.closed', reason: 'error' });
  }

  /**
   * A transport failure. Reported as the closing fact rather than as a warning
   * about one, because a socket error after open is terminal — the close that
   * follows it is the same event arriving twice, and is deduplicated by
   * `#closed`. The fault carries the detail `session.closed` has no room for,
   * and is the one fault marked unrecoverable: this session is gone.
   *
   * A transport without `onError` never reaches here, and its failures arrive
   * as `session.closed { reason: 'remote' }` — indistinguishable from a hangup,
   * which is what the optional member costs.
   */
  #handleSocketError(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#endInFlightTurns();
    this.#emit({
      type: 'fault',
      code: 'transport_error',
      message: error.message,
      recoverable: false,
    });
    this.#emit({ type: 'session.closed', reason: 'error' });
  }

  #emit(fact: UpstreamFact): void {
    this.#onFact(fact);
  }
}

/** Opens OpenAI Realtime sessions. One instance per configured transport. */
export class OpenAiRealtimeUpstream implements RealtimeUpstream {
  readonly id = 'openai-realtime';
  readonly capabilities: RealtimeCapabilities = OPENAI_REALTIME_CAPABILITIES;

  #options: OpenAiRealtimeUpstreamOptions;

  constructor(options: OpenAiRealtimeUpstreamOptions) {
    this.#options = options;
  }

  /**
   * Rejects an unsupported format before opening the transport: a format the
   * provider cannot serve is a configuration error, and converting around it
   * would turn a startup failure into a quality mystery nobody attributes to
   * this line.
   */
  async open(
    config: UpstreamSessionConfig,
    onFact: (fact: UpstreamFact) => void,
  ): Promise<OpenAiRealtimeUpstreamSession> {
    if (config.resumptionHandle) {
      // The seam requires the refusal: opening fresh would leave a caller that
      // believes it resumed holding no history and no way to notice.
      throw new Error(
        'OpenAI Realtime has no session resumption; open a fresh session and replay history',
      );
    }
    const inputFormat = negotiateAudioFormat({
      provider: 'OpenAI Realtime',
      direction: 'input',
      requested: config.inputFormat,
      supported: OPENAI_REALTIME_CAPABILITIES.supportedInputFormats,
    });
    const outputFormat = negotiateAudioFormat({
      provider: 'OpenAI Realtime',
      direction: 'output',
      requested: config.outputFormat,
      supported: OPENAI_REALTIME_CAPABILITIES.supportedOutputFormats,
    });
    const socket = await this.#options.connect();
    return new OpenAiRealtimeUpstreamSession({
      socket,
      config,
      onFact,
      voice: this.#options.voice ?? DEFAULT_VOICE,
      inputFormat,
      outputFormat,
      now: this.#options.now ?? Date.now,
    });
  }
}

/** G.711 carries no rate on the wire — the law implies 8 kHz. */
function toOpenAiFormat(format: AudioFormat): Record<string, unknown> {
  const type = OPENAI_FORMAT_TYPES[format.encoding];
  if (format.encoding === 'pcm16') {
    return { type, rate: format.sampleRateHz };
  }
  return { type };
}

function outcomeOf(status: string): 'completed' | 'interrupted' | 'failed' {
  if (status === 'failed') {
    return 'failed';
  }
  // An absent status is a response the provider considers finished; only the
  // named stop statuses mean it was cut short.
  return INTERRUPTED_STATUSES.has(status) ? 'interrupted' : 'completed';
}

function toOpenAiTool(tool: UpstreamToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function functionCallsOf(response: Record<string, unknown>): FunctionCall[] {
  if (!Array.isArray(response.output)) {
    return [];
  }
  const calls: FunctionCall[] = [];
  for (const part of response.output) {
    if (!isRecord(part) || part.type !== 'function_call') {
      continue;
    }
    calls.push({
      callId: stringField(part, 'call_id'),
      name: stringField(part, 'name'),
      args: parseArguments(stringField(part, 'arguments'), stringField(part, 'name')),
    });
  }
  return calls;
}

/** Unparseable arguments become an empty record: the call happened, its shape is unknown. */
function parseArguments(argumentsJson: string, name: string): Record<string, unknown> {
  if (!argumentsJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    logger.warn('[OpenAiRealtimeUpstream] unparseable tool arguments', { name });
  }
  return {};
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}
