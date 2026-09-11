import {
  type AudioFormat,
  PCM16_24K,
  type RealtimeCapabilities,
  type RealtimeUpstream,
  type RealtimeUpstreamSession,
  type SpeechReason,
  type UpstreamFact,
  type UpstreamSessionConfig,
  sameAudioFormat,
  supports,
} from './realtime-upstream.ts';
import type { VoiceDeliveryPolicy, VoiceDeliverySettlement } from './delivery-policy.ts';
import {
  BROWSER_ACTIVE_RUN_SILENCE_POLICY,
  SpeechScheduler,
  type ActiveRunSilencePolicy,
  type AdmissionSpeechIntent,
  type SpeechDeliveryOutcome,
  type SpeechIntent,
} from './speech-scheduler.ts';
import { toVoiceClientEvent } from './voice-client-wire.ts';
import { describeAudioFormat } from './util/audio-format.ts';
import { getVoiceLogger } from './util/logger.ts';
import { resamplePcm16 } from './util/pcm16-resample.ts';
import {
  describeVoiceToolOutcome,
  type VoiceFunctionToolDefinition,
  type VoiceToolResult,
} from './voice-tool-contracts.ts';
import {
  VoiceHistoryLog,
  type VoiceHistoryBatch,
  type VoiceTurnRoute,
} from './voice-history-log.ts';

const logger = getVoiceLogger();

const CLIENT_EVENT_ALLOWLIST = new Set([
  'input_audio_buffer.append',
  'voice.control',
  'voice.input',
  'voice.playback.completed',
  'voice.playback.truncate',
]);
const MAX_TEXT_INPUT_CHARS = 4_096;

/**
 * Caller-transcription policy for the browser surface.
 *
 * No `language`. Pinning one is what stopped a caller being heard in their own
 * language, and following the caller is behaviour worth having — a provider that
 * cannot be pinned demonstrated it, since the two that ignore this field are the
 * two that switch language happily.
 *
 * The `prompt` still earns its place, but it now protects the accent instead of
 * pinning the tongue. Those are separable problems that read as one: the failure
 * it was written for is a strong accent being decoded as a different language
 * altogether, which is a transcription error either way, and saying so directly
 * is what stops it — not forbidding every language but one.
 */
const CALLER_TRANSCRIPTION = {
  model: 'gpt-4o-mini-transcribe',
  prompt:
    'The speaker may have a strong non-native accent. Transcribe the language actually being spoken, verbatim, and never translate. Do not switch language on the strength of an accent alone.',
};

export interface VoiceClientLink {
  send(event: Record<string, unknown>): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type VoiceClientMessageCode =
  | 'history-write-failed'
  | 'text-input-invalid'
  | 'text-input-busy'
  | 'backend-error'
  | 'playback-reconciliation-failed';

const DEFAULT_CLIENT_MESSAGES: Record<VoiceClientMessageCode, string> = {
  'history-write-failed': 'Voice history could not be saved; conversation continuity is degraded.',
  'text-input-invalid': 'Voice text input is invalid.',
  'text-input-busy': 'Voice text input is busy.',
  'backend-error': 'Voice backend error.',
  'playback-reconciliation-failed':
    'Voice playback could not be reconciled; reconnect voice before continuing.',
};

/** Backward-compatible name for the provider-neutral voice tool definition. */
export type RealtimeToolDefinition = VoiceFunctionToolDefinition;

/**
 * How one host wants its voice to sound and behave — the deps a product surface
 * chooses, separated from the ones a transport supplies. A deployed front desk
 * and the builder differ here and nowhere else.
 */
export type VoiceSpeechProfile = Pick<
  RealtimeSessionManagerDeps,
  | 'instructions'
  | 'voice'
  | 'speakFirst'
  | 'busyToolNames'
  | 'greetingInstructions'
  | 'admissionInstructions'
  | 'progressInstructions'
  | 'livenessInstructions'
  | 'relayInstructions'
  | 'getResponseContext'
>;

export interface RealtimeSessionManagerDeps {
  /**
   * Opens the live provider session. Anything implementing {@link
   * RealtimeUpstream} will do — a provider adapter for a single connection, or
   * a shim whose `open` returns a `RotatingUpstreamSession`, which presents the
   * same session interface across as many connections as a long call needs.
   * Nothing below this line knows which it got.
   */
  upstream: RealtimeUpstream;
  client: VoiceClientLink;
  /** Host-owned stable wording; shared voice code stays independent of session locale state. */
  resolveClientMessage?: (code: VoiceClientMessageCode) => string;
  groundingText: string;
  toolExecutor: { execute(name: string, args: Record<string, unknown>): Promise<VoiceToolResult> };
  /** The engine-specific tool list advertised to the realtime model (deps, not a hardcoded import). */
  toolDefinitions: RealtimeToolDefinition[];
  idleTimeoutMs: number;
  maxSessionMs: number;
  voice?: string;
  /**
   * The session persona. Required and never defaulted: this library is
   * role-agnostic, and the one time it shipped a fallback persona it was a
   * builder's — which is what a deployed surface that forgot to pass its own
   * would have greeted visitors with.
   */
  instructions: string;
  /**
   * When false the session starts silent and the model speaks only after the
   * user's first turn — used when the conversation already has history, so
   * resumed sessions don't re-greet. Defaults to true (fresh conversations
   * open with a greeting).
   */
  speakFirst?: boolean;
  /**
   * When the attachment may start speaking.
   *
   * `'immediate'` (the default) speaks from `start()`. `'deferred'` opens the
   * provider session and accepts context, but stays silent until
   * {@link RealtimeSessionManager.activate} — which is what a transport needs
   * when its listener is not there yet: the session must be able to learn the
   * conversation first, and work that ran before the listener arrived must not
   * be announced to them afterwards.
   */
  activation?: 'immediate' | 'deferred';
  activeRunSilencePolicy?: ActiveRunSilencePolicy;
  /**
   * Where the caller's microphone is. A telephone leg is far-field by
   * construction; a browser on a laptop is not, and a provider tuned for the
   * wrong one treats speech as noise. Honoured only by a provider that declares
   * `callerNoiseReduction`.
   */
  callerAudio?: { noiseReduction: 'near_field' | 'far_field' };
  /**
   * Caller-transcription policy for this surface. Defaults to accent-protecting
   * steering with no language pinned, so a caller is followed into their own
   * language; a surface that must transcribe in one language sets it here
   * rather than having an adapter decide.
   */
  callerTranscription?: { model?: string; language?: string; prompt?: string };
  /** Transport evidence for full, partial, or unconfirmed listener delivery. */
  deliveryPolicy?: VoiceDeliveryPolicy;
  /**
   * The wire format the CLIENT link carries, in both directions. Defaults to
   * linear PCM16 at 24 kHz — what both browser surfaces capture and play.
   *
   * Declared rather than assumed because the client's rate is fixed (an
   * `AudioContext` keeps one for its life) while the provider's is whatever the
   * adapter negotiated, and the two disagree: Gemini Live accepts 16 kHz input
   * and nothing else. Adapters never convert on purpose — a format a provider
   * cannot serve is a refusal at `open` — so bridging the two rates is this
   * class's job, as the one component that holds both ends. Rate only:
   * a companded client leg (µ-law/A-law) is a different encoding, and this
   * refuses it at {@link RealtimeSessionManager.start} instead of guessing.
   */
  clientAudioFormat?: AudioFormat;
  /**
   * Tool names whose execution flips the client to the long-lived 'building'
   * state (other tools show 'thinking' and reset to 'listening' when done).
   * Defaults to the builder stack's forward tool.
   */
  busyToolNames?: readonly string[];
  /**
   * Per-response instruction overrides for the out-of-band speech kinds.
   * Defaults are builder-framed ("this app-building product") — a deployed
   * front-desk engine MUST pass visitor-framed variants or fresh sessions
   * greet with builder wording.
   */
  greetingInstructions?: string;
  admissionInstructions?: string;
  progressInstructions?: string;
  livenessInstructions?: string;
  relayInstructions?: string;
  /** Fresh screen-state block appended to every response's instructions; '' = none. */
  getResponseContext?: () => string;
  /** Fires only after transport delivery settles for an active relay. */
  onRelayOutcome?: (runId: string, outcome: 'full' | 'partial' | 'unconfirmed') => void;
  /**
   * Writes one terminal projection of a caller turn, or of out-of-band speech,
   * to the session's durable planes. Omitted where an attachment keeps no
   * durable history; supplied, it is awaited and its failure is reported rather
   * than swallowed.
   */
  onHistoryBatch?: (batch: VoiceHistoryBatch) => Promise<void> | void;
  /**
   * Attachment-scoped identity carried on every history batch. Defaults to a
   * generated id. It is process-local correlation, never durable authority —
   * see {@link VoiceHistoryLog}.
   */
  historySessionId?: string;
  /**
   * Teed from every `usage` fact, verbatim. The builder gateway bills through
   * this via UsageTracker; a deployed front-desk engine omits it because the
   * relay it triggers already bills separately.
   *
   * The provider's record is passed through rather than reduced here: which
   * token buckets are billable, and how modalities nest inside them, is the
   * billing layer's model, not a voice-session concern. Reducing it here also
   * dropped the modality detail, so audio minutes billed at text rates.
   *
   * `generation` is the connection the figures belong to, where the upstream
   * rotates and reports it (`UpstreamFact.usage.generation`), and undefined
   * otherwise. A biller whose provider reports session-cumulative totals must
   * meter each generation separately or it bills the second connection nothing;
   * one that reports per-turn deltas may ignore it.
   */
  onUsage?: (usage: Record<string, unknown>, generation: number | undefined) => void;
}

const GREETING_INSTRUCTIONS = `Give ONE short opener sentence in your own words — never reference tools or past topics. This is a fresh conversation: invite them to start. Phrase it differently every session; avoid canned lines.`;

const ADMISSION_INSTRUCTIONS = `The work has started. Give one brief, natural acknowledgement based on the structured fact below, as the one doing the work yourself — never say you will ask, forward, or pass anything to anyone. Do not repeat the request, mention internal routing, or reuse an acknowledgement or sentence pattern already heard.

Admission: `;

const PROGRESS_INSTRUCTIONS = `Convey the confirmed progress fact below in one short, natural sentence. Preserve its meaning and exact quantities, but author the wording from the conversation instead of reciting the fact. Do not infer another step, result, percentage, or screen change. Never read search queries, URLs, code, or file paths aloud — describe what they mean in plain speech. If the fact adds nothing the listener has not already heard, produce no speech at all. Avoid repeating wording or sentence patterns already heard.

Progress fact: `;

export const ACTIVE_RUN_LIVENESS_INSTRUCTIONS = `The request is being worked on and has not finished; there is no new user-relevant fact to report yet. In one short, natural sentence, keep the listener oriented — nothing more. Do NOT answer the request, guess at it, or say you cannot find or do it: the work in progress will deliver the result, and speaking against it is the one failure this message can cause. Do not claim a specific step, result, percentage, source, or screen change. If nothing natural remains to say, produce no speech at all — staying quiet is allowed here. Avoid repeating the form of earlier updates.`;

const RELAY_INSTRUCTIONS = `Deliver the result below to the user. Summarize only its single most important point aloud in ONE short sentence (two only if truly essential), in your own words — never verbatim, no lists, no file names or technical identifiers. Be honest about WHO acts: if the result needs the USER to act, for a choice between options ask which they'd like; for something to do on screen (connect, authorize, a form) tell them it's ready for them — NEVER claim you will do or have done it, and never narrate it as "waiting to select". Do NOT ask a follow-up question unless the result genuinely requires the user to decide something.

Result: `;

/**
 * What a tool call the response was never allowed to make is answered with.
 * Model-facing wording, so it only ever reaches a provider that does not speak a
 * tool result back — see the refusal path in `#refuseStrayToolCalls`.
 */
const STRAY_TOOL_CALL_REFUSAL = 'Refused — this response must not act. Wait for the user.';

const TRANSCRIPT_MAX_LINES = 24;
/**
 * How long a truncate may go unanswered before the mismatch is reported. The
 * pre-seam manager carried the same deadline for the same reason: a provider
 * that neither confirms nor refuses has a conversation that no longer matches
 * what the listener heard, and nobody would otherwise ever learn it.
 */
const TRUNCATE_CONFIRMATION_MS = 5_000;
/** How many settled delivery records are remembered, so a late fact cannot reopen one. */
const ALREADY_SAID_LINES = 2;
const ALREADY_SAID_LINE_MAX_CHARS = 160;

const SETTLED_PLAYBACK_MEMORY = 32;
/** Ledger items beyond this count trigger a batched eviction (v3 W2: rare + batched, one amortized cache bust). */
const LEDGER_MAX_ITEMS = 12;
const LEDGER_EVICT_BATCH = 4;
/** Spoken-greeting transcripts are trimmed to this length before becoming a conversation item. */
const SPOKEN_GREETING_MAX_CHARS = 500;

type ResponseKind = 'user-turn' | SpeechIntent['kind'];

/**
 * Fault codes that report speech the provider will never produce, naming the
 * turn it abandoned. They are that turn's terminal rather than a backend
 * failure: a greeting the model declined to speak must not toast the listener,
 * and must not leave the scheduler waiting on a turn that is already over.
 */
const UNSPOKEN_SPEECH_FAULT_CODES: ReadonlySet<string> = new Set([
  'speech_not_produced',
  'speech_superseded',
]);

interface PendingToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

interface PendingPlayback {
  turnId: string;
  kind: ResponseKind;
  intent: SpeechIntent | null;
  transcript: string;
  emittedAudioBytes: number;
  outputTerminal: boolean;
  settled: boolean;
}

/**
 * Owns one realtime voice session under the response-taxonomy design: only a
 * committed user turn creates a tool-capable response; narration, relays, and
 * the greeting are spoken out-of-band with their note delivered as per-response
 * instructions, so nothing stale persists or replays — except the greeting's
 * own spoken words, which are written back as a plain assistant item once it
 * finishes, so the visitor's first reply lands in a conversation that already
 * knows it happened. All speech timing is owned by the SpeechScheduler. User
 * turns preempt any non-user turn in flight (a hard cancel), and drop a
 * same-named greeting still waiting unfired in the scheduler.
 *
 * It drives a {@link RealtimeUpstreamSession} rather than a provider socket.
 * The taxonomy above is expressed as a {@link SpeechReason} per request — the
 * adapter decides how its provider renders "out-of-band, tools off", because
 * whether that is `conversation: 'none'` or an impossibility is a provider
 * fact. Everything this class reaches for beyond the mandatory surface is
 * capability-checked, so wiring a provider that cannot cancel, cannot be
 * written to mid-session, or replies on its own after a tool result needs no
 * change here: the branch already exists and OpenAI simply takes the other leg.
 */
export class RealtimeSessionManager {
  #deps: RealtimeSessionManagerDeps;
  #capabilities: RealtimeCapabilities;
  #session: RealtimeUpstreamSession | null = null;
  #scheduler: SpeechScheduler;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #maxTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #activated = false;
  #userLine = '';
  #assistantLine = '';
  #transcript: string[] = [];
  #activeKind: ResponseKind | null = null;
  #lastFiredIntent: SpeechIntent | null = null;
  #pendingUserTurn = false;
  #endAfterResponse = false;
  /**
   * Facts an adapter reported before `open` resolved. Nova announces its own
   * readiness from the constructor, so a session that only starts listening
   * once it holds the handle misses whatever arrived in between.
   */
  #factsBeforeOpen: UpstreamFact[] = [];
  /**
   * The turn currently being spoken, once the adapter has named it. Cancel is
   * addressed to a turn rather than to "whatever is speaking" — a bare cancel
   * is how one caller question turned into five overlapping answers.
   */
  #activeTurnId: string | null = null;
  /** A cancel decided before the turn had an id, replayed the moment it gets one. */
  #cancelOnceTurnKnown = false;
  /**
   * A turn already retired by the fault that named it. An adapter reporting
   * both a fault and `model.turn.ended` for the same abandoned turn is stating
   * one end twice, and releasing the scheduler twice would start a second
   * response over the one the first release just fired. Cleared by the
   * restatement it explains, or by the next turn to start.
   */
  #retiredTurnId: string | null = null;
  /**
   * Which speech request is current. `speak` resolves asynchronously, so a
   * request whose turn has already ended can hand its id back after the next
   * turn has begun — and binding that would address the next cancel to a turn
   * nobody is listening to. The epoch is what makes a late resolution
   * recognizable as stale rather than plausible.
   */
  #speechEpoch = 0;
  /** Tool calls reported for a turn, held until that turn ends. */
  #toolCallsByTurnId = new Map<string, PendingToolCall[]>();
  #playbackByTurnId = new Map<string, PendingPlayback>();
  #runProgressFacts = new Map<string, string>();
  /** Trims sent and not yet confirmed or refused, by the turn they trim. */
  #pendingTruncates = new Map<string, ReturnType<typeof setTimeout>>();
  #history: VoiceHistoryLog | null = null;
  /** Resolves once shutdown's final history writes have settled. */
  #historyFlushed: Promise<void> = Promise.resolve();
  #textInputCounter = 0;
  /** A caller item this session committed itself, so the provider's echo of it is not a second turn. */
  #locallyCommittedItemId: string | null = null;
  #ledgerItemIds: string[] = [];
  /**
   * Context handles with an eviction in flight. A fault caused by one of our
   * own `removeContext` calls names the item as `fault.contextId`, so an
   * eviction that raced the provider already dropping the item is recognized by
   * comparison instead of by matching the id against the error's prose.
   * One-shot: the id is consumed by the fault it explains, because the seam
   * reports no confirmation for a delete that succeeded.
   */
  #pendingContextDeletes = new Set<string>();
  /** Whether this session has already reported that its conversation cannot be written. */
  #undeliverableContextReported = false;

  constructor(deps: RealtimeSessionManagerDeps) {
    this.#deps = deps;
    this.#capabilities = deps.upstream.capabilities;
    this.#scheduler = new SpeechScheduler({
      speak: (intent) => this.#fireIntent(intent),
      activeRunSilence: deps.activeRunSilencePolicy ?? BROWSER_ACTIVE_RUN_SILENCE_POLICY,
      onLivenessFailure: (reason) =>
        logger.warn('[RealtimeSessionManager] active-run liveness disabled', { reason }),
    });
    deps.deliveryPolicy?.start(this.#deliverySettlement());
    this.#history = deps.onHistoryBatch
      ? new VoiceHistoryLog({
          sessionId: deps.historySessionId ?? generateHistorySessionId(),
          emit: deps.onHistoryBatch,
          onWriteFailed: () =>
            deps.client.send({
              type: 'voice.error',
              message: this.#clientMessage('history-write-failed'),
            }),
        })
      : null;
  }

  #deliverySettlement(): VoiceDeliverySettlement {
    return {
      markPlaybackCompleted: (turnId) => this.#settlePlayback(turnId, 'full'),
      truncatePlayback: (turnId, _contentIndex, audioEndMs) => {
        // A settled turn owes the provider nothing more: a late trim would
        // name audio the provider no longer holds, be refused, and arm a
        // reconciliation deadline nobody can meet.
        if (this.#playbackByTurnId.get(turnId)?.settled) {
          logger.debug('[Voice] late trim for a settled turn ignored', { turnId });
          return;
        }
        const session = this.#session;
        if (session && supports(session, 'truncateAtPlayback')) {
          session.truncate?.(turnId, audioEndMs);
          this.#awaitTruncateConfirmation(turnId);
        }
        this.#settlePlayback(turnId, 'partial', audioEndMs);
      },
      markPlaybackUnconfirmed: (turnId, message) => {
        logger.warn('[RealtimeSessionManager] listener delivery unconfirmed', {
          turnId,
          message,
        });
        this.#settlePlayback(turnId, 'unconfirmed');
      },
    };
  }

  /**
   * Opens the session and starts the conversation. Rejects exactly as the
   * upstream's `open` rejects — a session that cannot be opened is a failure to
   * start the call, not a degraded call.
   */
  async start(): Promise<void> {
    const session = await this.#deps.upstream.open(this.#sessionConfig(), (fact) =>
      this.#handleFact(fact),
    );
    this.#assertClientAudioIsBridgeable(session);
    if (this.#closed) {
      // Shut down while the dial was still in flight, so `shutdown` closed the
      // session it could see — which was none. Nothing else holds this
      // connection, so closing it here is the only thing that ever will.
      logger.info('[RealtimeSessionManager] the session opened after shutdown; closing it', {
        upstream: this.#deps.upstream.id,
      });
      session.close();
      return;
    }
    this.#session = session;
    const buffered = this.#factsBeforeOpen;
    this.#factsBeforeOpen = [];
    for (const fact of buffered) {
      this.#handleFact(fact);
    }

    this.#deliverGrounding();
    if (this.#deps.activation !== 'deferred') {
      this.activate();
    }

    this.#deps.client.onClose(() => this.shutdown('client closed'));
    if (this.#closed) {
      // A client that hung up during the dial is reported by calling the handler
      // straight away, so `shutdown` has already run — before either timer
      // existed, and every later `shutdown` returns at the closed guard. Arming
      // them now would leave both running with nothing left to clear them,
      // holding this manager, its scheduler and its transcript for the whole of
      // `maxSessionMs`.
      return;
    }

    this.#armIdleTimer();
    this.#maxTimer = setTimeout(
      () => this.shutdown('max session duration'),
      this.#deps.maxSessionMs,
    );
    this.#maxTimer.unref?.();
  }

  /**
   * Puts the session's grounding where this provider can still receive it.
   *
   * Where the conversation can be written, grounding is a system-role item: that
   * is what it is, and the rotation layer replays the same ledger into every
   * replacement connection. Where it cannot, the grounding was already seeded at
   * open (see `#groundingSeed`) and writing it again here would only produce a
   * refusal.
   */
  #deliverGrounding(): void {
    if (!this.#capabilities.mutableConversation) {
      return;
    }
    this.injectContext(this.#deps.groundingText);
  }

  /**
   * Marks the listener present: from here the attachment may speak, and greets
   * unless the conversation already has history.
   *
   * Idempotent, because a transport may signal readiness more than once — a
   * second greeting is the failure this guards.
   */
  activate(options?: { speakFirst?: boolean }): void {
    if (this.#closed || this.#activated) {
      return;
    }
    this.#activated = true;
    // A caller who already spoke is answered rather than greeted. On a line
    // that carries audio from the moment it connects, the provider can commit
    // an utterance before the listener side is ready, and opening with "hello"
    // after someone has asked a question is the wrong turn to take.
    if (this.#pendingUserTurn) {
      this.#fireUserTurn();
      return;
    }
    if (options?.speakFirst ?? this.#deps.speakFirst !== false) {
      this.#scheduler.schedule({ kind: 'greeting' });
    }
  }

  handleClientEvent(event: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (!CLIENT_EVENT_ALLOWLIST.has(type)) {
      logger.warn('[RealtimeSessionManager] dropped non-allowlisted client event', { type });
      return;
    }
    if (this.#deps.deliveryPolicy?.handleAttachmentEvent(event)) {
      return;
    }
    if (type === 'voice.control') {
      if (event.action === 'end') {
        this.shutdown('client ended');
      }
      return;
    }
    if (type === 'voice.input') {
      this.#handleTextInput(event);
      return;
    }
    this.#armIdleTimer();
    const audio = typeof event.audio === 'string' ? event.audio : '';
    if (audio) {
      this.#sendCallerAudio(Buffer.from(audio, 'base64'));
    }
  }

  #handleTextInput(event: Record<string, unknown>): void {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text || text.length > MAX_TEXT_INPUT_CHARS) {
      this.#deps.client.send({
        type: 'voice.error',
        message: this.#clientMessage('text-input-invalid'),
      });
      return;
    }
    if (this.#activeKind !== null || this.#pendingUserTurn) {
      this.#deps.client.send({
        type: 'voice.error',
        message: this.#clientMessage('text-input-busy'),
      });
      return;
    }
    const session = this.#session;
    if (!session) {
      return;
    }
    this.#textInputCounter += 1;
    const callerItemId = `voice_text_${this.#textInputCounter}`;
    this.#locallyCommittedItemId = callerItemId;
    session.sendText(text, callerItemId);
    this.#history?.beginUserTurn(callerItemId);
    this.#history?.noteTranscript(text);
    this.#onUserTurnCommitted();
  }

  /** Caller audio, converted to the rate the session negotiated (usually a no-op). */
  #sendCallerAudio(audio: Uint8Array): void {
    const session = this.#session;
    if (!session) {
      return;
    }
    const client = this.#clientAudioFormat();
    session.sendAudio(resamplePcm16(audio, client.sampleRateHz, session.inputFormat.sampleRateHz));
  }

  #clientAudioFormat(): AudioFormat {
    return this.#deps.clientAudioFormat ?? PCM16_24K;
  }

  /**
   * Refuses at start a pairing this class cannot bridge, closing the session it
   * just opened rather than leaving a provider connection billing for audio
   * nobody can hear.
   *
   * Sample rates are bridged (see {@link RealtimeSessionManagerDeps.clientAudioFormat});
   * an encoding difference is companding rather than resampling, and a caller
   * holding companded audio should negotiate that format with the provider — the
   * OpenAI adapter serves both G.711 laws — instead of having it invented here.
   */
  #assertClientAudioIsBridgeable(session: RealtimeUpstreamSession): void {
    const client = this.#clientAudioFormat();
    const legs: ReadonlyArray<readonly ['input' | 'output', AudioFormat]> = [
      ['input', session.inputFormat],
      ['output', session.outputFormat],
    ];
    for (const [direction, provider] of legs) {
      if (provider.encoding === client.encoding) {
        continue;
      }
      session.close();
      throw new Error(
        `the client link carries ${describeAudioFormat(client)}, but this provider's ` +
          `${direction} audio is ${describeAudioFormat(provider)} — encodings are not converted here`,
      );
    }
  }

  /**
   * The same fact with its audio at the client's rate. Identity for a provider
   * that already emits it — which is every provider configured today, so the
   * comparison is what runs on the hot path, not the conversion.
   */
  #toClientAudioRate(fact: UpstreamFact): UpstreamFact {
    const session = this.#session;
    if (fact.type !== 'model.audio' || !session) {
      return fact;
    }
    const client = this.#clientAudioFormat();
    if (sameAudioFormat(session.outputFormat, client)) {
      return fact;
    }
    return {
      ...fact,
      audio: resamplePcm16(fact.audio, session.outputFormat.sampleRateHz, client.sampleRateHz),
    };
  }

  shutdown(reason: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    logger.info('[RealtimeSessionManager] shutdown', { reason });
    this.#scheduler.dispose();
    for (const timer of this.#pendingTruncates.values()) {
      clearTimeout(timer);
    }
    this.#pendingTruncates.clear();
    this.#historyFlushed = this.#history?.dispose() ?? Promise.resolve();
    this.#deps.deliveryPolicy?.dispose();
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
    }
    if (this.#maxTimer) {
      clearTimeout(this.#maxTimer);
    }
    this.#session?.close();
    this.#deps.client.close();
  }

  /**
   * Hands a confirmed progress fact or terminal result to the shared scheduler.
   *
   * Speech scheduled before the listener is present is dropped rather than
   * queued: it belongs to work they never asked for and did not watch, and
   * replaying it at activation is how a caller is greeted with the end of
   * somebody else's task.
   */
  schedule(intent: Extract<SpeechIntent, { kind: 'progress' | 'relay' }>): void {
    if (this.#closed) {
      return;
    }
    if (!this.#activated) {
      logger.debug('[Voice] speech dropped: the attachment is not active yet', {
        kind: intent.kind,
      });
      return;
    }
    if (intent.kind === 'progress') {
      this.#runProgressFacts.set(intent.runId, intent.fact);
    }
    if (
      intent.kind === 'relay' &&
      (this.#activeKind === 'admission' ||
        this.#activeKind === 'progress' ||
        this.#activeKind === 'liveness')
    ) {
      logger.info('[Voice] transient speech preempted by relay', { cancelled: this.#activeKind });
      this.#cancelActiveTurn();
    }
    this.#scheduler.schedule(intent);
  }

  /**
   * Outstanding delegated work, mirrored to the browser as `voice.run` edges:
   * `busy: true` when the first run appears, `busy: false` when the last one
   * retires. The browser cannot infer this from audio states — speech keeps
   * flowing while a run works — and a raised indicator with no falling edge
   * spins forever, which is exactly the bug this signal exists to prevent.
   */
  #outstandingRunIds = new Set<string>();

  noteRunOutstanding(runId: string): void {
    if (runId && !this.#outstandingRunIds.has(runId)) {
      this.#outstandingRunIds.add(runId);
      if (this.#outstandingRunIds.size === 1) {
        this.#deps.client.send({ type: 'voice.run', busy: true });
      }
    }
    this.#scheduler.noteRunOutstanding(runId);
  }

  noteRunTerminal(runId: string): void {
    this.#runProgressFacts.delete(runId);
    if (this.#outstandingRunIds.delete(runId) && this.#outstandingRunIds.size === 0) {
      this.#deps.client.send({ type: 'voice.run', busy: false });
    }
    this.#scheduler.noteRunTerminal(runId);
  }

  setRunLivenessSuspended(runId: string, suspended: boolean): void {
    this.#scheduler.setRunLivenessSuspended(runId, suspended);
  }

  /**
   * Injects a persistent conversation item. Reserved for dialogue-relevant
   * context (grounding, a pending builder question) — progress notes must go
   * through `schedule()` and never persist.
   *
   * Delivery is not guaranteed, and the caller is not told per call: where the
   * provider accepts conversation only at open, the session's own grounding was
   * seeded there and anything written afterwards has nowhere to go. Those writes
   * are dropped and reported once for the session, never silently absorbed as if
   * they had landed.
   */
  injectContext(text: string): void {
    this.#appendContext('system', text);
  }

  /**
   * Appends an assistant-role conversation item — the running ledger of what
   * the voice has told the user, distinct from `injectContext`'s system-role
   * grounding. Append-only; once the ledger exceeds `LEDGER_MAX_ITEMS`, the
   * oldest `LEDGER_EVICT_BATCH` items are evicted together.
   *
   * A provider that accepts the write but issues no handle for it still gets
   * the item; it simply cannot be evicted, so it is not tracked here rather
   * than tracked under an id `removeContext` would reject.
   */
  appendLedgerItem(text: string): void {
    const id = this.#appendContext('assistant', text);
    if (id === null) {
      return;
    }
    this.#ledgerItemIds.push(id);
    if (this.#ledgerItemIds.length > LEDGER_MAX_ITEMS) {
      this.#evictOldestLedgerItems();
    }
  }

  /**
   * Writes one past conversation message — a caller utterance or an answer the
   * listener already heard — so a reattached session continues a conversation
   * it can see. Outside the ledger: seeded common ground must not be evicted by
   * live speech.
   */
  appendConversationMessage(role: 'user' | 'assistant', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.#appendContext(role, trimmed);
  }

  /**
   * The greeting is the one out-of-band response whose spoken words must
   * become common ground: it is the first thing the visitor hears, so if it
   * leaves no trace the model sees an empty conversation and greets again the
   * moment the visitor replies. Recorded as an assistant item deliberately
   * outside `#ledgerItemIds`, so a run of ledger evictions can never carry it
   * away.
   */
  #appendSpokenGreetingItem(transcript: string): void {
    const trimmed = transcript.trim().slice(0, SPOKEN_GREETING_MAX_CHARS);
    if (!trimmed) {
      return;
    }
    this.#appendContext('assistant', trimmed);
  }

  /** Requires `mutableConversation`; returns the handle the provider issued, if any. */
  #appendContext(role: 'system' | 'assistant' | 'user', text: string): string | null {
    const session = this.#session;
    if (this.#closed || !session) {
      return null;
    }
    if (!supports(session, 'mutableConversation')) {
      this.#reportUndeliverableContext(role);
      return null;
    }
    return session.appendContext?.(role, text) ?? null;
  }

  /**
   * Said once per session rather than once per write.
   *
   * A provider that accepts conversation only at open holds the grounding it was
   * seeded with and nothing the session learns afterwards: a screen-state
   * snapshot, a delivered result, a builder question waiting on an answer. There
   * is no channel left to carry them — the write is refused rather than accepted
   * and discarded — and the fact does not change between the first dropped item
   * and the fiftieth, so it is stated plainly once instead of as a warning per
   * call that buries the rest of the session's log.
   */
  #reportUndeliverableContext(role: 'system' | 'assistant' | 'user'): void {
    if (this.#undeliverableContextReported) {
      return;
    }
    this.#undeliverableContextReported = true;
    logger.warn(
      '[RealtimeSessionManager] this provider accepts conversation only at open: the session ' +
        'opened holding its grounding, and every context update written from now on is dropped',
      { upstream: this.#deps.upstream.id, firstDropped: role },
    );
  }

  #evictOldestLedgerItems(): void {
    const session = this.#session;
    const evicted = this.#ledgerItemIds.splice(0, LEDGER_EVICT_BATCH);
    for (const id of evicted) {
      this.#pendingContextDeletes.add(id);
      session?.removeContext?.(id);
    }
  }

  /**
   * Resolves once the final history writes of a shutdown have settled — the
   * boundary a graceful teardown (a VM draining, a test asserting durable
   * state) must wait behind. `shutdown` itself stays synchronous because its
   * callers are timers and close handlers; this is where the waiting lives.
   */
  flushed(): Promise<void> {
    return this.#historyFlushed;
  }

  /** Ends the session once the current/next response finishes (lets the goodbye play). */
  endAfterCurrentResponse(): void {
    this.#endAfterResponse = true;
  }

  /**
   * External activity signal — re-arms the idle timer. The timer otherwise
   * resets only on client (mic) events, so a visitor driving the session from
   * the screen while voice is open would be cut off mid-use.
   */
  noteActivity(): void {
    if (this.#closed) {
      return;
    }
    this.#armIdleTimer();
  }

  /** Rolling tail of the voice conversation (last TRANSCRIPT_MAX_LINES lines). */
  getTranscriptTail(): string {
    return this.#transcript.join('\n');
  }

  #isSpeechFactForSettledTurn(fact: UpstreamFact): boolean {
    if (
      fact.type !== 'model.audio' &&
      fact.type !== 'model.audio.done' &&
      fact.type !== 'model.text'
    ) {
      return false;
    }
    return this.#playbackByTurnId.get(fact.turnId)?.settled === true;
  }

  #handleFact(fact: UpstreamFact): void {
    if (!this.#session) {
      this.#factsBeforeOpen.push(fact);
      return;
    }
    if (this.#closed) {
      return;
    }
    this.#observePlaybackFact(fact);
    this.#accumulateTranscript(fact);
    // A settled turn is over for the listener: its tail was still in flight
    // when they barged in, and forwarding it replays a ghost of the
    // interrupted utterance — which the browser's next barge then "trims"
    // with audio the provider no longer holds.
    if (!this.#isSpeechFactForSettledTurn(fact)) {
      const clientEvent = toVoiceClientEvent(this.#toClientAudioRate(fact));
      if (clientEvent) {
        this.#deps.client.send(clientEvent);
      }
    }

    switch (fact.type) {
      case 'caller.speech.started':
        this.#onCallerSpeechStarted();
        return;
      case 'caller.turn.committed':
        this.#onCallerTurnCommitted(fact.callerItemId);
        return;
      case 'model.turn.started':
        this.#onTurnStarted(fact.turnId, fact.reason);
        return;
      case 'tool.called':
        this.#rememberToolCall(fact);
        return;
      case 'model.turn.ended':
        this.#onTurnEnded(fact.turnId, fact.outcome);
        return;
      case 'usage':
        this.#deps.onUsage?.(fact.raw, fact.generation);
        return;
      case 'fault':
        this.#onFault(fact);
        return;
      case 'context.truncated':
        this.#clearPendingTruncate(fact.turnId);
        return;
      case 'session.closed':
        this.shutdown('peer closed');
        return;
      default:
        return;
    }
  }

  #observePlaybackFact(fact: UpstreamFact): void {
    if (fact.type === 'model.audio') {
      const playback = this.#openPlayback(fact.turnId);
      if (playback) {
        playback.emittedAudioBytes += fact.audio.byteLength;
      }
      return;
    }
    if (fact.type === 'model.text') {
      const playback = this.#openPlayback(fact.turnId);
      if (!playback) {
        return;
      }
      playback.transcript = fact.final ? fact.text : playback.transcript + fact.text;
      return;
    }
    if (fact.type !== 'model.audio.done') {
      return;
    }
    const playback = this.#openPlayback(fact.turnId);
    if (!playback || playback.outputTerminal) {
      return;
    }
    playback.outputTerminal = true;
    this.#deps.deliveryPolicy?.onOutputTerminal({
      itemId: fact.turnId,
      emittedAudioBytes: playback.emittedAudioBytes,
    });
  }

  /**
   * Barge-in for speech the provider will not interrupt on its own. Provider
   * VAD interruption covers only in-conversation replies; out-of-band speech
   * (greeting, liveness, progress, narration, relay) streams straight through
   * caller speech, so the orchestrator applies the same signal at the same
   * instant. Replies stay untouched — cancelling them here would race the
   * provider's own interruption. Providers without `hardCancel` interrupt
   * every turn natively, so there is nothing for this hook to do there.
   */
  #onCallerSpeechStarted(): void {
    if (this.#activeKind === null || this.#activeKind === 'user-turn') {
      return;
    }
    const session = this.#session;
    if (!session || !supports(session, 'hardCancel')) {
      return;
    }
    logger.info('[Voice] out-of-band speech interrupted by caller barge-in', {
      cancelled: this.#activeKind,
    });
    this.#cancelActiveTurn();
  }

  /**
   * A committed user turn is the ONLY trigger for a tool-capable response.
   * It preempts any non-user turn in flight — including a relay (user
   * decision: "you win"); a cancelled relay is not re-queued. A greeting
   * still sitting unfired in the scheduler (e.g. requeued behind a peer
   * race) is dropped here too — it must never surface after the user has
   * already started talking. An already-playing greeting is untouched by
   * this eviction; the cancel branch below and VAD interruption handle it.
   */
  /**
   * The provider reporting a caller item. A session that committed the item
   * itself — text input — has already opened that turn, and taking the echo for
   * a second caller turn answers one utterance twice.
   */
  #onCallerTurnCommitted(callerItemId: string | undefined): void {
    if (callerItemId !== undefined && callerItemId === this.#locallyCommittedItemId) {
      this.#locallyCommittedItemId = null;
      return;
    }
    this.#beginHistoryUserTurn(callerItemId);
    this.#onUserTurnCommitted();
  }

  #beginHistoryUserTurn(callerItemId: string | undefined): void {
    if (!this.#history) {
      return;
    }
    this.#history.beginUserTurn(callerItemId);
    if (!this.#capabilities.canTranscribeCaller) {
      this.#history.failTranscription();
    }
  }

  #onUserTurnCommitted(): void {
    this.#scheduler.evictQueued('greeting');
    if (!this.#activated) {
      // Held, not answered: before activation there is no listener to answer
      // to. The utterance is already recorded for history; `activate` serves it.
      this.#pendingUserTurn = true;
      return;
    }
    if (!this.#capabilities.clientDrivenTurns) {
      // The provider owns turn onset; its reply arrives as its own turn, and
      // asking for one here would produce a second, overlapping answer.
      return;
    }
    if (this.#activeKind !== null && this.#activeKind !== 'user-turn') {
      logger.info('[Voice] narration preempted by user turn', { cancelled: this.#activeKind });
      this.#cancelActiveTurn();
      this.#pendingUserTurn = true;
      return;
    }
    if (this.#activeKind === 'user-turn') {
      this.#pendingUserTurn = true;
      return;
    }
    this.#fireUserTurn();
  }

  #fireUserTurn(): void {
    this.#pendingUserTurn = false;
    this.#activeKind = 'user-turn';
    this.#lastFiredIntent = null;
    this.#scheduler.onUserResponseStarted();
    logger.info('[Voice] speak', { kind: 'user-turn', trigger: 'committed' });
    const context = this.#responseContext();
    const instructions = this.#deps.instructions;
    // An empty direction leaves the session's own instructions in force, which
    // is what a reply with nothing extra to say should run under.
    this.#requestSpeech('reply', context ? `${instructions}\n\n${context}` : '');
  }

  #fireIntent(intent: SpeechIntent): void {
    if (this.#closed) {
      return;
    }
    this.#activeKind = intent.kind;
    this.#lastFiredIntent = intent;
    logger.info('[Voice] speak', { kind: intent.kind, trigger: 'scheduler' });
    const baseInstructions = instructionsFor(intent, this.#scheduler.msSinceLastSpoken(), {
      greeting: this.#deps.greetingInstructions,
      admission: this.#deps.admissionInstructions,
      progress: this.#deps.progressInstructions,
      liveness: this.#deps.livenessInstructions,
      relay: this.#deps.relayInstructions,
    });
    // A progress response already carries its own fact as direction, and the
    // liveness response for that run is precisely the one forbidden to claim a
    // fact — handing it the sentence invites it to say it twice.
    const context = this.#responseContext(
      intent.kind === 'progress' || intent.kind === 'liveness' ? intent.runId : undefined,
    );
    const saidLines =
      intent.kind === 'liveness' || intent.kind === 'progress' ? this.#alreadySaidBlock() : '';
    const direction = [baseInstructions, saidLines, context].filter(Boolean).join('\n\n');
    this.#requestSpeech(intent.kind, direction);
  }

  /**
   * What every response is told about the world beyond its own direction: the
   * confirmed progress facts of runs still outstanding, then the transport's
   * own context block. Progress facts are transient — `noteRunTerminal` drops
   * them — so this is a view of live work, never a second history.
   *
   * A progress response excludes its own fact: it is already the subject of
   * that response's instructions, and repeating it invites the model to say it
   * twice in one breath.
   */
  /**
   * The recent out-of-band lines the listener actually heard, quoted into the
   * next liveness direction. "Avoid repeating yourself" used to lean on ledger
   * writeback timing and on the provider reading the conversation for
   * out-of-band responses — neither is guaranteed. Quoting the lines inside
   * the request makes repetition refutable and gives the silence permission
   * its evidence: these lines are the proof there may be nothing new to say.
   */
  #alreadySaidBlock(): string {
    const lines: string[] = [];
    for (const playback of this.#playbackByTurnId.values()) {
      if (!playback.settled || playback.kind === 'user-turn' || playback.kind === 'greeting') {
        continue;
      }
      const transcript = playback.transcript.trim();
      if (transcript) {
        lines.push(transcript.slice(0, ALREADY_SAID_LINE_MAX_CHARS));
      }
    }
    const recent = lines.slice(-ALREADY_SAID_LINES);
    if (recent.length === 0) {
      return '';
    }
    const quoted = recent.map((line) => `"${line}"`).join(' / ');
    return `You already said: ${quoted}. Say something genuinely new about the situation, or produce no speech at all.`;
  }

  #responseContext(excludeRunId?: string): string {
    const facts = [...this.#runProgressFacts.entries()]
      .filter(([runId]) => runId !== excludeRunId)
      .map(([, fact]) => `- ${fact}`);
    const blocks: string[] = [];
    if (facts.length > 0) {
      blocks.push(`CONFIRMED PROGRESS ON WORK STILL RUNNING:\n${facts.join('\n')}`);
    }
    const transportContext = this.#deps.getResponseContext?.() ?? '';
    if (transportContext) {
      blocks.push(transportContext);
    }
    return blocks.join('\n\n');
  }

  /**
   * Asks the session to speak and binds the turn it opened. The request is not
   * awaited by the caller: a turn id is needed only to cancel, which cannot
   * happen before the request that mints it has been made.
   */
  #requestSpeech(reason: SpeechReason, text: string): void {
    const session = this.#session;
    if (this.#closed) {
      return;
    }
    this.#speechEpoch += 1;
    if (!session) {
      // Speech asked for before the session exists is refused rather than
      // dropped: the scheduler treats a fired intent as a response in flight,
      // and one that never ends would silence every later intent too.
      this.#onSpeechRefused(this.#speechEpoch, reason, 'the session is not open yet');
      return;
    }
    this.#activeTurnId = null;
    this.#cancelOnceTurnKnown = false;
    const epoch = this.#speechEpoch;
    void session.speak({ reason, text, fidelity: 'model-voice-required' }).then(
      (turnId) => this.#onSpeechAccepted(epoch, reason, turnId),
      (error: unknown) =>
        this.#onSpeechRefused(
          epoch,
          reason,
          error instanceof Error ? error.message : String(error),
        ),
    );
  }

  #onSpeechAccepted(epoch: number, reason: SpeechReason, turnId: string | null): void {
    if (epoch !== this.#speechEpoch) {
      return;
    }
    if (turnId === null) {
      this.#onSpeechRefused(epoch, reason, 'the provider declined to speak');
      return;
    }
    this.#bindActiveTurn(turnId);
  }

  /**
   * Speech the provider would not produce. OpenAI never refuses, but a
   * provider that cannot speak unprompted will, and the scheduler must not stay
   * blocked on a turn that will never end.
   */
  #onSpeechRefused(epoch: number, reason: SpeechReason, message: string): void {
    if (epoch !== this.#speechEpoch) {
      return;
    }
    logger.warn('[Voice] speech refused', { reason, message });
    this.#activeKind = null;
    this.#lastFiredIntent = null;
    this.#activeTurnId = null;
    this.#cancelOnceTurnKnown = false;
    this.#scheduler.onResponseDone();
  }

  #bindActiveTurn(turnId: string): void {
    this.#activeTurnId = turnId;
    this.#openPlayback(turnId, this.#activeKind ?? undefined);
    if (this.#cancelOnceTurnKnown) {
      this.#cancelOnceTurnKnown = false;
      this.#cancelActiveTurn();
    }
  }

  /** Requires `hardCancel`. Held until the turn has an id, so it stops that turn and no other. */
  #cancelActiveTurn(): void {
    const session = this.#session;
    if (!session || !supports(session, 'hardCancel')) {
      logger.warn('[RealtimeSessionManager] provider cannot cancel a turn in flight');
      return;
    }
    if (this.#activeTurnId === null) {
      this.#cancelOnceTurnKnown = true;
      return;
    }
    session.cancel?.(this.#activeTurnId);
  }

  /**
   * A turn the provider says has started — including one nobody asked for.
   *
   * Its `reason` is what decides whether the turn may act, and reading it is
   * not optional on a provider that owns turn onset: there the caller's reply
   * arrives as the provider's own turn (`clientDrivenTurns: false` means the
   * manager never opened one), so a manager that only knows the kinds it fired
   * itself takes every caller reply for background speech and answers the
   * caller's request with the stray-tool-call refusal.
   */
  #onTurnStarted(turnId: string, reason: SpeechReason | 'unprompted'): void {
    const kind = responseKindFor(reason);
    this.#activeKind = kind;
    this.#retiredTurnId = null;
    this.#bindActiveTurn(turnId);
    this.#scheduler.onResponseStarted();
  }

  /**
   * The delivery record for a turn, opened on first sight of it.
   *
   * The record is what makes "was this heard?" answerable later: a provider
   * that finished generating has proved only that it spoke, and the listener's
   * transport settles the rest. Records are opened by whichever comes first —
   * the turn id a speech request resolved, the provider announcing the turn, or
   * the first audio of it — because not every provider reports all three.
   *
   * Returns null for a turn already settled, so a late fact cannot reopen a
   * delivery that has been accounted for.
   */
  #openPlayback(turnId: string, kind?: ResponseKind): PendingPlayback | null {
    const existing = this.#playbackByTurnId.get(turnId);
    // A turn id is only unique within one provider connection: a replacement
    // connection numbers turns from one again, so a settled record is a memory
    // rather than a claim on the id. A named kind means a turn genuinely began
    // and takes the id back; a bare fact cannot reopen what is accounted for.
    if (existing && !(existing.settled && kind !== undefined)) {
      if (existing.settled) {
        return null;
      }
      if (kind) {
        existing.kind = kind;
        existing.intent = kind === 'user-turn' ? null : this.#lastFiredIntent;
      }
      return existing;
    }
    const opened: PendingPlayback = {
      turnId,
      kind: kind ?? this.#activeKind ?? 'progress',
      intent: kind === 'user-turn' ? null : this.#lastFiredIntent,
      transcript: '',
      emittedAudioBytes: 0,
      outputTerminal: false,
      settled: false,
    };
    this.#playbackByTurnId.set(turnId, opened);
    this.#history?.noteSpeechOpened(turnId, opened.kind);
    this.#pruneSettledPlaybacks();
    return opened;
  }

  /** Settled records are kept only as a short memory of what must not reopen. */
  #pruneSettledPlaybacks(): void {
    if (this.#playbackByTurnId.size <= SETTLED_PLAYBACK_MEMORY) {
      return;
    }
    for (const [turnId, playback] of this.#playbackByTurnId) {
      if (this.#playbackByTurnId.size <= SETTLED_PLAYBACK_MEMORY) {
        return;
      }
      if (playback.settled) {
        this.#playbackByTurnId.delete(turnId);
      }
    }
  }

  /**
   * Settles one turn's delivery exactly once.
   *
   * `full` is the only outcome that makes speech common ground: the listener
   * heard the whole utterance, so later turns may see the exact words through
   * the provider conversation rather than through a phrase memory. `partial`
   * and `unconfirmed` leave no trace, because words nobody finished hearing
   * are not shared ground.
   */
  #settlePlayback(turnId: string, outcome: SpeechDeliveryOutcome, audioEndMs?: number): void {
    const playback = this.#playbackByTurnId.get(turnId);
    if (!playback || playback.settled) {
      return;
    }
    playback.settled = true;
    this.#deps.deliveryPolicy?.onOutputSettled(turnId);
    logger.info('[Voice] delivery settled', {
      turnId,
      kind: playback.kind,
      outcome,
      audioEndMs,
    });
    if (outcome === 'full') {
      this.#recordHeardSpeech(playback);
    }
    const intentRunId =
      playback.intent && 'runId' in playback.intent ? playback.intent.runId : undefined;
    this.#history?.noteSpeechSettled(turnId, {
      status: outcome,
      text: playback.transcript.trim(),
      ...(intentRunId ? { runId: intentRunId } : {}),
      ...(audioEndMs === undefined ? {} : { audioEndMs }),
    });
    this.#emitRelayOutcome(playback.intent, outcome);
    if (playback.kind === 'liveness' && playback.emittedAudioBytes === 0) {
      this.#scheduler.onLivenessResponseWithoutDelivery();
      return;
    }
    this.#scheduler.onSpeechDelivered(playback.kind, outcome);
    if (this.#endAfterResponse && this.#activeKind === null) {
      this.shutdown('ended by voice');
    }
  }

  /**
   * Exact speech the listener heard, written back as an assistant item so the
   * next response continues a conversation that contains it. A user turn is
   * already part of the provider's own conversation, so only out-of-band
   * speech needs the write.
   */
  #recordHeardSpeech(playback: PendingPlayback): void {
    const transcript = playback.transcript.trim();
    if (playback.kind === 'user-turn' || !transcript) {
      return;
    }
    if (playback.kind === 'greeting') {
      this.#appendSpokenGreetingItem(transcript);
      return;
    }
    this.appendLedgerItem(transcript);
  }

  #rememberToolCall(fact: Extract<UpstreamFact, { type: 'tool.called' }>): void {
    if (this.#capabilities.expectsToolResultDuringTurn) {
      this.#runToolCallDuringTurn(fact);
      return;
    }
    const calls = this.#toolCallsByTurnId.get(fact.turnId) ?? [];
    calls.push({ callId: fact.callId, name: fact.name, args: fact.args });
    this.#toolCallsByTurnId.set(fact.turnId, calls);
  }

  /**
   * Runs a call the provider is holding its turn open for.
   *
   * Deferring to {@link #retireTurn} is the right shape where a tool call ends
   * the turn, because then the two coincide. Where the turn stays open until the
   * result arrives, deferring is a deadlock: the provider is waiting for us and
   * we are waiting for the provider, and the caller hears nothing until something
   * unrelated breaks the tie.
   *
   * Not buffered as well as run. A call must not be executed twice, and the
   * buffer exists only so retirement can find calls it has not seen — which is
   * exactly what this path removes.
   *
   * The kind still decides whether the call may act, and it is already known: the
   * turn started before the provider reached for a tool, so `#activeKind` is set.
   * Background speech gets the same refusal it would get at retirement, and for
   * the same reason — a greeting or a progress note comes out silent when it
   * carries a tool call.
   */
  #runToolCallDuringTurn(fact: Extract<UpstreamFact, { type: 'tool.called' }>): void {
    const call: PendingToolCall = { callId: fact.callId, name: fact.name, args: fact.args };
    const kind: ResponseKind = this.#activeKind ?? 'progress';
    if (kind === 'user-turn') {
      void this.#executeUserTurnCalls([call]);
      return;
    }
    this.#refuseStrayToolCalls([call], kind);
  }

  #onTurnEnded(turnId: string, outcome: 'completed' | 'interrupted' | 'failed'): void {
    if (this.#retiredTurnId === turnId) {
      // The fault that named this turn already retired it; see #retiredTurnId.
      this.#retiredTurnId = null;
      return;
    }
    this.#retireTurn(turnId, outcome);
  }

  /** Closes out a finished turn: its tool calls, its delivery, and the scheduler slot it held. */
  #retireTurn(turnId: string, outcome: 'completed' | 'interrupted' | 'failed'): void {
    const doneKind: ResponseKind = this.#activeKind ?? 'progress';
    const doneIntent = this.#lastFiredIntent;
    this.#flushTranscriptLines();
    this.#activeKind = null;
    this.#lastFiredIntent = null;
    if (this.#activeTurnId === turnId) {
      this.#activeTurnId = null;
    }
    const calls = this.#toolCallsByTurnId.get(turnId) ?? [];
    this.#toolCallsByTurnId.delete(turnId);

    const deliveryPending = this.#settleOrDeferDelivery(turnId, outcome, doneIntent);

    if (this.#endAfterResponse) {
      if (deliveryPending) {
        // The farewell is still playing in the listener's browser; closing the
        // socket now clips it mid-word. Settlement (confirmation, truncate, or
        // the delivery deadline) fires the shutdown — see #settlePlayback.
        return;
      }
      this.shutdown('ended by voice');
      return;
    }

    if (doneKind === 'user-turn') {
      if (calls.length > 0) {
        void this.#executeUserTurnCalls(calls);
        return;
      }
      this.#history?.noteUserTurnTerminal();
    } else {
      this.#refuseStrayToolCalls(calls, doneKind);
    }

    if (this.#pendingUserTurn) {
      this.#fireUserTurn();
      return;
    }
    this.#scheduler.onResponseDone({ deliveryPending });
  }

  /**
   * Whether the listener's transport still owes evidence for this turn.
   *
   * A transport that reports playback settles the record on its own signals,
   * so retirement only hands the scheduler the wait. Where no transport
   * evidence exists at all — no delivery policy, or a turn whose audio the
   * provider abandoned before any terminal — the turn's own outcome is the
   * best available account and the record settles here rather than hanging.
   */
  #settleOrDeferDelivery(
    turnId: string,
    outcome: 'completed' | 'interrupted' | 'failed',
    doneIntent: SpeechIntent | null,
  ): boolean {
    const playback = this.#playbackByTurnId.get(turnId);
    if (playback?.settled) {
      // The transport already accounted for this turn; retiring it adds nothing
      // and would report the same relay a second time.
      return false;
    }
    if (!playback) {
      this.#emitRelayOutcome(doneIntent, outcome === 'completed' ? 'full' : 'partial');
      return false;
    }
    const awaitsTransport = this.#deps.deliveryPolicy !== undefined && playback.outputTerminal;
    if (awaitsTransport) {
      return true;
    }
    this.#settlePlayback(turnId, outcome === 'completed' ? 'full' : 'partial');
    return false;
  }

  /**
   * Reports how much of a relay the listener actually heard, once the
   * transport has settled it. Provider completion is deliberately not the
   * trigger: a result the caller never heard must not be recorded as
   * delivered.
   */
  #emitRelayOutcome(intent: SpeechIntent | null, outcome: SpeechDeliveryOutcome): void {
    if (intent?.kind !== 'relay' || !intent.runId || !this.#deps.onRelayOutcome) {
      return;
    }
    this.#deps.onRelayOutcome(intent.runId, outcome);
  }

  /**
   * `perResponseToolChoice` makes tool calls on non-user turns impossible by
   * contract; this belt refuses any that slip through and logs loudly — that
   * log line existing is a bug signal on a provider that declares the
   * capability, and the expected shape of the world on one that does not.
   *
   * Whether the refusal is put on the wire is `autoRepliesAfterTool`, and the
   * flag inverts the usual sense here exactly as it does in the sibling gate in
   * `#executeUserTurnCalls`: true means do less, not more. Where the provider
   * answers a tool result on its own, a submitted result is not a note to the
   * model: it is the next thing the caller hears, an internal sentence read back
   * mid-progress-update, on a turn nobody asked for — and one this provider
   * names as its own, so the manager takes it for a caller-driven reply and lets
   * it act. Nothing is handed back there. The provider is left with an
   * unanswered call, which it treats as a turn that produced nothing, and the
   * caller hears the silence a refusal is supposed to be.
   */
  #refuseStrayToolCalls(calls: PendingToolCall[], kind: ResponseKind | null): void {
    const answerable = !this.#capabilities.autoRepliesAfterTool;
    for (const call of calls) {
      logger.warn('[Voice] tool call refused on non-user-turn response', {
        kind,
        name: call.name,
        answered: answerable,
      });
      if (!answerable) {
        continue;
      }
      this.#session?.submitToolResult(call.callId, STRAY_TOOL_CALL_REFUSAL);
    }
  }

  /**
   * Tool execution continues the user turn: the scheduler stays blocked until
   * the calls resolve, then either a follow-up user-turn response speaks the
   * results (any `speak: true`) or the turn ends and the scheduler resumes.
   */
  async #executeUserTurnCalls(calls: PendingToolCall[]): Promise<void> {
    let anySpeak = false;
    for (const call of calls) {
      const busyNames = this.#deps.busyToolNames ?? [];
      const busyState = busyNames.includes(call.name) ? 'building' : 'thinking';
      this.#deps.client.send({ type: 'voice.state', state: busyState });
      const result = await this.#deps.toolExecutor.execute(call.name, call.args);
      if (this.#closed) {
        return;
      }
      this.#session?.submitToolResult(call.callId, describeVoiceToolOutcome(result.outcome));
      this.#noteDelegationRoute(result);
      anySpeak = anySpeak || result.speak;
      if (busyState === 'thinking') {
        this.#deps.client.send({ type: 'voice.state', state: 'listening' });
      }
    }

    if (this.#capabilities.autoRepliesAfterTool) {
      // The provider answers a tool result on its own; that turn drives the
      // scheduler when it starts. Asking for one here produces two answers.
      return;
    }
    if (anySpeak || this.#pendingUserTurn) {
      this.#fireUserTurn();
      return;
    }
    // The caller's turn ends here: the tools ran, nothing more will be said
    // about it, and its history record must not wait for a turn that is never
    // coming. A turn that speaks again terminalizes when that turn retires.
    this.#history?.noteUserTurnTerminal();
    this.#scheduler.onResponseDone();
  }

  /** Where a delegating tool sent the caller's request, for that turn's history. */
  #noteDelegationRoute(result: VoiceToolResult): void {
    const delegation = result.delegation;
    if (!this.#history || !delegation) {
      return;
    }
    this.#history.noteRoute(routeForDelegation(delegation));
  }

  #onFault(fault: Extract<UpstreamFact, { type: 'fault' }>): void {
    if (fault.code === 'response_cancel_not_active') {
      logger.info('[RealtimeSessionManager] cancel raced a finishing response — benign');
      return;
    }
    if (fault.code === 'conversation_already_has_active_response') {
      logger.info('[RealtimeSessionManager] speech raced an active response; requeued');
      this.#requeueRejectedTurn();
      return;
    }
    if (UNSPOKEN_SPEECH_FAULT_CODES.has(fault.code)) {
      this.#onUnspokenSpeech(fault);
      return;
    }
    if (fault.code === 'truncate_failed' && fault.turnId !== undefined) {
      this.#clearPendingTruncate(fault.turnId);
      this.#reportUnreconciledPlayback(fault.turnId, fault.message);
      return;
    }
    if (fault.contextId !== undefined && this.#pendingContextDeletes.delete(fault.contextId)) {
      logger.warn('[RealtimeSessionManager] ledger eviction failed — id already gone upstream', {
        contextId: fault.contextId,
        code: fault.code,
      });
      return;
    }
    logger.warn('[RealtimeSessionManager] upstream fault', { fault });
    this.#deps.client.send({
      type: 'voice.error',
      message: this.#clientMessage('backend-error'),
    });
  }

  /**
   * Speech the provider abandoned — it produced nothing for the direction, or
   * the caller took the floor first. Recoverable and expected on a provider
   * that cannot be told to hold its tools or its tongue, so the listener hears
   * about it only as the silence it is, never as a backend error.
   *
   * The named turn is retired here rather than waited on, because the fault is
   * the last word some adapters have on it. An adapter that also reports
   * `model.turn.ended` is restating this end, and {@link #retiredTurnId} is
   * what keeps the restatement from releasing the scheduler a second time.
   */
  #onUnspokenSpeech(fault: Extract<UpstreamFact, { type: 'fault' }>): void {
    logger.info('[RealtimeSessionManager] the provider did not speak a requested turn', {
      code: fault.code,
      turnId: fault.turnId,
      kind: this.#activeKind,
    });
    if (fault.turnId === undefined || this.#activeKind === null) {
      return;
    }
    if (this.#activeTurnId !== null && this.#activeTurnId !== fault.turnId) {
      return;
    }
    this.#retiredTurnId = fault.turnId;
    this.#retireTurn(fault.turnId, 'failed');
  }

  /**
   * Arms the deadline a sent truncate must be answered within. Delivery and
   * history already settled from the browser's own clock; what this guards is
   * the PROVIDER's conversation — a trim it refused or lost leaves the model
   * holding a sentence the listener never heard, and it will refer back to it.
   */
  #awaitTruncateConfirmation(turnId: string): void {
    this.#clearPendingTruncate(turnId);
    const timer = setTimeout(() => {
      this.#pendingTruncates.delete(turnId);
      this.#reportUnreconciledPlayback(turnId, 'the provider never answered the truncate');
    }, TRUNCATE_CONFIRMATION_MS);
    timer.unref?.();
    this.#pendingTruncates.set(turnId, timer);
  }

  #clearPendingTruncate(turnId: string): void {
    const timer = this.#pendingTruncates.get(turnId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.#pendingTruncates.delete(turnId);
  }

  /**
   * The one honest thing to tell the listener: their conversation's record no
   * longer matches what they heard, and reconnecting is what rebuilds it from
   * durable history. Named for what happened — the generic backend-error toast
   * this used to fall into blamed the platform for a bookkeeping mismatch.
   */
  #reportUnreconciledPlayback(turnId: string, detail: string): void {
    logger.warn('[RealtimeSessionManager] playback reconciliation failed', { turnId, detail });
    this.#deps.client.send({
      type: 'voice.error',
      message: this.#clientMessage('playback-reconciliation-failed'),
    });
  }

  #clientMessage(code: VoiceClientMessageCode): string {
    const message = this.#deps.resolveClientMessage?.(code) ?? DEFAULT_CLIENT_MESSAGES[code];
    return message.trim() || DEFAULT_CLIENT_MESSAGES[code];
  }

  /** A turn the provider refused to create: the intent survives, the turn does not. */
  #requeueRejectedTurn(): void {
    this.#activeTurnId = null;
    this.#cancelOnceTurnKnown = false;
    if (this.#lastFiredIntent) {
      this.#scheduler.requeue(this.#lastFiredIntent);
      this.#lastFiredIntent = null;
      this.#activeKind = null;
      return;
    }
    if (this.#activeKind === 'user-turn') {
      this.#pendingUserTurn = true;
      this.#activeKind = null;
    }
  }

  /**
   * Interim transcripts only. The final fact restates the whole utterance the
   * deltas already built, so counting both would write every line twice.
   */
  #accumulateTranscript(fact: UpstreamFact): void {
    if (fact.type === 'caller.transcript') {
      if (fact.final) {
        this.#history?.noteTranscript(fact.text, fact.callerItemId);
        return;
      }
      this.#userLine += fact.text;
      return;
    }
    if (fact.type === 'model.text' && !fact.final) {
      this.#assistantLine += fact.text;
    }
  }

  #flushTranscriptLines(): void {
    if (this.#userLine.trim()) {
      this.#transcript.push(`User: ${this.#userLine.trim()}`);
    }
    if (this.#assistantLine.trim()) {
      this.#transcript.push(`Assistant: ${this.#assistantLine.trim()}`);
    }
    this.#userLine = '';
    this.#assistantLine = '';
    if (this.#transcript.length > TRANSCRIPT_MAX_LINES) {
      this.#transcript.splice(0, this.#transcript.length - TRANSCRIPT_MAX_LINES);
    }
  }

  #sessionConfig(): UpstreamSessionConfig {
    const config: UpstreamSessionConfig = {
      instructions: this.#deps.instructions,
      tools: this.#deps.toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
    const seed = this.#groundingSeed();
    if (seed) {
      config.history = seed;
    }
    if (this.#deps.voice) {
      config.voice = this.#deps.voice;
    }
    if (this.#capabilities.canTranscribeCaller) {
      config.transcription = { ...CALLER_TRANSCRIPTION, ...this.#deps.callerTranscription };
    }
    if (this.#deps.callerAudio && this.#capabilities.callerNoiseReduction) {
      config.callerAudio = this.#deps.callerAudio;
    }
    return config;
  }

  /**
   * The grounding a provider whose conversation cannot be written gets at open —
   * the one moment it accepts conversation at all. Without it such a session runs
   * with no agent name, no project summary and no history tail for the whole
   * call. What arrives later still cannot be delivered; that is stated once,
   * where the write is refused, rather than papered over here.
   *
   * Seeded as `history` rather than written after open because that is the only
   * channel that survives a rotation: a replacement connection is opened with the
   * transcript, and the transcript is itself seeded with this list, so it stays
   * the first thing every later generation is told without the orchestrator
   * writing anything. A context write, by contrast, is refused on this provider
   * and would be re-refused once per generation.
   *
   * The role is `user` because the seam's history carries no system role and a
   * leading assistant entry is dropped by a provider that requires the
   * conversation to begin with the caller. Seeding requests no generation on any
   * adapter, so this never becomes a turn of its own.
   */
  #groundingSeed(): ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> | null {
    const text = this.#deps.groundingText.trim();
    if (this.#capabilities.mutableConversation || !text) {
      return null;
    }
    return [{ role: 'user', text }];
  }

  #armIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
    }
    this.#idleTimer = setTimeout(() => this.shutdown('idle timeout'), this.#deps.idleTimeoutMs);
    this.#idleTimer.unref?.();
  }
}

const RECENT_SPEECH_MS = 4_000;
const CONTINUATION_NOTE = `You finished saying something moments ago — continue in the same breath: no greeting, no preamble, no "okay so", just flow straight into it.\n\n`;

/**
 * What a turn's reason means for tool policy.
 *
 * `reply` and `unprompted` are the two shapes a caller-driven answer takes —
 * the client asked for one, or the provider's server decided on its own — and
 * both may act, including the follow-up a provider generates after a tool
 * result (`autoRepliesAfterTool`). Everything else is out-of-band speech: a
 * greeting or a progress note that calls a tool comes out silent, so its calls
 * are refused. A reason added later lands there too, which is the safe side.
 */
function responseKindFor(reason: SpeechReason | 'unprompted'): ResponseKind {
  switch (reason) {
    case 'reply':
    case 'unprompted':
      return 'user-turn';
    case 'greeting':
      return 'greeting';
    case 'relay':
      return 'relay';
    case 'admission':
      return 'admission';
    case 'liveness':
      return 'liveness';
    // `narration` is the undifferentiated predecessor of `progress`; an adapter
    // still reporting it names out-of-band speech, which is what `progress` is.
    case 'narration':
    case 'progress':
      return 'progress';
  }
}

interface SpeechInstructionOverrides {
  greeting?: string;
  admission?: string;
  progress?: string;
  liveness?: string;
  relay?: string;
}

/**
 * The direction one response runs under. Each speech kind states its own
 * obligation: an admission may claim acceptance, progress may claim the fact it
 * carries, liveness may claim nothing at all, and a relay carries the result.
 * No kind is given prior wording to avoid — what the listener already heard
 * lives in the conversation, not in a phrase list.
 */
function instructionsFor(
  intent: SpeechIntent,
  msSinceLastSpoken: number,
  overrides: SpeechInstructionOverrides = {},
): string {
  const continuation = msSinceLastSpoken < RECENT_SPEECH_MS ? CONTINUATION_NOTE : '';
  switch (intent.kind) {
    case 'greeting':
      return overrides.greeting ?? GREETING_INSTRUCTIONS;
    case 'admission':
      return `${continuation}${overrides.admission ?? ADMISSION_INSTRUCTIONS}${admissionFact(intent)}`;
    case 'progress':
      return `${continuation}${overrides.progress ?? PROGRESS_INSTRUCTIONS}${intent.fact}`;
    case 'liveness':
      return `${continuation}${overrides.liveness ?? ACTIVE_RUN_LIVENESS_INSTRUCTIONS}`;
    case 'relay':
      return `${continuation}${overrides.relay ?? RELAY_INSTRUCTIONS}${intent.note}`;
  }
}

function routeForDelegation(
  delegation: NonNullable<VoiceToolResult['delegation']>,
): VoiceTurnRoute {
  switch (delegation.status) {
    case 'started':
      return { status: 'delegated-started', runId: delegation.runId };
    case 'queued':
      return { status: 'delegated-queued', runId: delegation.runId };
    case 'busy':
      return { status: 'rejected' };
    case 'failed':
      return { status: 'local-failed' };
  }
}

/** Attachment-scoped identity for history correlation; never durable authority. */
function generateHistorySessionId(): string {
  return `voice_${globalThis.crypto.randomUUID()}`;
}

/** The admitted-or-not fact, stated plainly for the model to phrase. */
function admissionFact(intent: AdmissionSpeechIntent): string {
  switch (intent.status) {
    case 'started':
      return 'the request was accepted and is running now.';
    case 'queued':
      return 'the request was accepted and is waiting behind work already running.';
    case 'busy':
      return 'the request was not accepted because other work is already running.';
    case 'failed':
      return intent.reason
        ? `the request could not be accepted: ${intent.reason}`
        : 'the request could not be accepted.';
  }
}
