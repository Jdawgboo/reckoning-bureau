/**
 * Session rotation: an unbroken conversation across provider connections that
 * all three providers cut short.
 *
 * Every provider studied caps a connection below the length of an ordinary phone
 * call — OpenAI at 60 minutes, Gemini at ~10, Nova Sonic at a hard 8 — and only
 * Gemini warns before it happens. Rotation is therefore not a provider concern
 * one adapter can hide; it is infrastructure all three need, which is why it
 * lives above the seam and reads capability declarations rather than provider
 * names.
 *
 * ## What it presents
 *
 * A {@link RealtimeUpstreamSession}. The orchestrator above sends audio, asks for
 * speech, returns tool results and reads facts exactly as it would against one
 * connection, and never learns that the connection underneath was replaced. That
 * is the point: rotation is invisible when it works, so anything that makes it
 * visible — a second `session.opened`, a `session.closed` mid-call, a turn id
 * colliding with an earlier turn's — is a bug in here.
 *
 * ## The rules it enforces
 *
 * 1. **Never mid-utterance.** Arming and switching are separate. The rotator arms
 *    on a warning or its own timer, pre-opens the replacement while the current
 *    session keeps talking, and switches only once nothing is still in flight on
 *    the outgoing connection: the model has stopped speaking, no speech it
 *    accepted is still waiting to begin, no tool call is outstanding, and the
 *    caller's own utterance has reached the conversation. Whatever is left with
 *    the old connection at the switch is lost — its frames arrive on a session
 *    that has been superseded and nothing re-issues them.
 *
 * 2. **But the wait is bounded.** Waiting forever for a boundary means the cap
 *    arrives first and the connection dies mid-sentence anyway — the same
 *    failure, with no report. So the wait has a deadline derived from what the
 *    provider stated, after which the rotator switches regardless and says so:
 *    the rotation event names `deadline` as the boundary and a `fault` reaches the
 *    orchestrator. A cut utterance is a fact about the call, not an edge case to
 *    swallow.
 *
 * 3. **Continuity by declaration.** `sessionResumption` decides: hand the
 *    provider its own handle, or replay a transcript. Never both — doing both
 *    reads to the model as the caller having said everything twice. And because
 *    both are settled when the rotation *arms*, the conversation moves on while
 *    the model finishes speaking: the switch closes that gap by writing the
 *    difference into the replacement, or, on a provider that accepts conversation
 *    only at open, by dialling once more with the transcript as it stands.
 *
 * 4. **Money is not lost at the seam.** A superseded session is not closed at the
 *    instant of the switch. Nova's usage events for a turn keep arriving seconds
 *    after the turn ends — measured still arriving 4.7 s after a turn's final
 *    transcript — so the old session lingers with only its `usage` facts still
 *    forwarded, each naming the generation that owes it. The full contract is on
 *    {@link RotatingUpstreamSession}.
 *
 * 5. **Connection state does not travel; each generation earns it again.**
 *    Continuity carries the conversation, not the provider's per-connection state,
 *    so a provider that will not speak until it has heard audio starts every
 *    replacement in that condition. Because a replacement is opened through the
 *    upstream's own `open`, an adapter that primes its container at open primes
 *    every generation for free — which is how the Nova path works, and worth
 *    verifying rather than assuming for a new adapter. Where an adapter does NOT
 *    prime, it declares `canSpeakBeforeFirstInput: false` and the first `speak` of
 *    each generation is refused until audio reaches it, reported rather than
 *    silently swallowed. See {@link RotatingUpstreamSession.speak}.
 */

import {
  type ContinuityStrategy,
  type RotationTiming,
  type RotationTimingOptions,
  boundaryWaitFor,
  continuityStrategy,
  resolveRotationTiming,
} from './rotation-policy.ts';
import {
  type AudioFormat,
  type RealtimeCapabilities,
  type RealtimeUpstream,
  type RealtimeUpstreamSession,
  type SpeakRequest,
  type UpstreamFact,
  type UpstreamSessionConfig,
  type UpstreamToolDefinition,
  sameAudioFormat,
} from './realtime-upstream.ts';
import { getVoiceLogger } from './util/logger.ts';
import {
  type ScheduleVoiceTimer,
  type VoiceTimerHandle,
  scheduleVoiceTimer,
} from './util/timers.ts';
import {
  type TranscriptEntry,
  VoiceTranscript,
  type VoiceTranscriptOptions,
} from './voice-transcript.ts';

const logger = getVoiceLogger();

/**
 * Why the rotator is not switching yet. Empty means the switch can happen now.
 *
 * `speech-requested` covers the window a turn id does not exist in yet: `speak`
 * is a round trip, so speech the provider has accepted is invisible in the fact
 * stream until `model.turn.started` arrives, and a switch in that window orphans
 * the utterance. `caller-speaking` is its mirror on the input side — the caller's
 * audio went to the live connection and the transcript that closes the utterance
 * comes back on that same connection.
 */
export type RotationBlocker =
  | 'model-speaking'
  | 'speech-requested'
  | 'caller-speaking'
  | 'tool-outstanding';

export type RotationPhase = 'live' | 'armed' | 'awaiting-boundary' | 'closed';

/** What made the rotator arm. */
export type RotationTrigger = 'provider-warning' | 'local-timer';

/**
 * Where the switch actually happened.
 *
 * `idle` and `turn-ended` are the healthy outcomes. `deadline` means the bounded
 * wait expired with the model still busy — the caller was probably cut off.
 * `session-lost` means the old connection died before the switch, so the caller
 * heard a gap.
 */
export type RotationBoundary = 'idle' | 'turn-ended' | 'deadline' | 'session-lost';

/**
 * Rotation is reported here rather than as an `UpstreamFact` because facts are
 * what a *provider* reports, and rotation is something this library does. Adding
 * a fact type would also oblige every orchestrator to learn to ignore it.
 *
 * Only failures the orchestrator can act on cross into the fact stream, as
 * `fault`s.
 */
export type RotationEvent =
  | {
      type: 'armed';
      generation: number;
      trigger: RotationTrigger;
      /** `session.ending.inMs` as stated, or null when the local timer armed us. */
      providerInMs: number | null;
      /** How long the boundary wait may last from now. */
      boundaryWaitMs: number;
    }
  | {
      type: 'opening';
      generation: number;
      attempt: number;
      continuity: ContinuityStrategy;
      historyEntries: number;
    }
  | { type: 'open-failed'; generation: number; attempt: number; error: string; willRetry: boolean }
  | {
      type: 'abandoned';
      generation: number;
      /**
       * `stale-history` is the healthy one: the session was seeded when the
       * rotation armed, the conversation moved on while the model finished
       * speaking, and this provider cannot be told the difference — so it is
       * dropped in favour of one dialled with the conversation as it stands.
       */
      reason: 'open-exhausted' | 'format-mismatch' | 'closed' | 'stale-history';
    }
  | {
      type: 'awaiting-boundary';
      generation: number;
      blockers: RotationBlocker[];
      boundaryWaitMs: number;
    }
  | {
      type: 'completed';
      fromGeneration: number;
      toGeneration: number;
      boundary: RotationBoundary;
      continuity: ContinuityStrategy;
      /**
       * Conversation entries the replacement holds: what it was seeded with at
       * open, plus anything written into it at the switch to close the gap since.
       * 0 on the resumption path where nothing had to be topped up.
       */
      historyEntries: number;
      /** Last `usage.raw` seen from the outgoing session at the moment of the switch. */
      lastUsage: Record<string, unknown> | null;
    }
  | {
      type: 'linger-ended';
      generation: number;
      /** `usage` facts forwarded from the superseded session during the linger window. */
      lateUsageFacts: number;
    };

/** A snapshot for an operator or a health check. Cheap; safe to poll. */
export interface RotationState {
  generation: number;
  phase: RotationPhase;
  replacementReady: boolean;
  blockers: RotationBlocker[];
  completedRotations: number;
  lingeringSessions: number;
  bufferedAudioBytes: number;
}

export interface RotatingUpstreamOptions {
  upstream: RealtimeUpstream;
  /** Config for every generation. `history` seeds the transcript for the first. */
  config: UpstreamSessionConfig;
  onFact: (fact: UpstreamFact) => void;
  onRotation?: (event: RotationEvent) => void;
  timing?: RotationTimingOptions;
  transcript?: Omit<VoiceTranscriptOptions, 'seed'>;
  /** Opens attempted per rotation before giving up. */
  openAttempts?: number;
  openRetryDelayMs?: number;
  /**
   * How long after a rotation gave up before another is armed. The pre-arm point
   * is behind us by then, so this is the whole of the spacing.
   */
  rearmDelayMs?: number;
  /**
   * How long a superseded session stays open, forwarding only `usage`. Nova bills
   * for a turn well after the turn ends; closing at the switch loses it.
   */
  lingerMs?: number;
  /**
   * How long a silent line is tolerated when the old session dies before the
   * replacement is ready. On expiry the withheld `session.closed` is released and
   * the call ends — an honest hangup beats an open line nobody is on.
   */
  gapToleranceMs?: number;
  /** Caller audio held while no session is live. Oldest bytes drop first. */
  maxBufferedAudioBytes?: number;
  scheduleTimer?: ScheduleVoiceTimer;
  now?: () => number;
}

interface Generation {
  index: number;
  session: RealtimeUpstreamSession;
  openedAt: number;
  opened: boolean;
  dead: boolean;
  /** How this generation inherited the conversation. Reported at the switch. */
  continuity: ContinuityStrategy;
  /** Entries it was seeded with, so the switch can report what it cost. */
  historyEntries: number;
  /**
   * The conversation this generation holds by virtue of being opened — the
   * replayed transcript, or what the resumption handle is assumed to cover. The
   * switch measures the delta against it, since everything said after this
   * snapshot is conversation the session has never been told.
   */
  carriedHistory: ReadonlyArray<TranscriptEntry>;
  /** Tool list it was opened with, so a later `setTools` can be re-applied. */
  tools: UpstreamToolDefinition[];
  /** Set while this generation is lingering for its trailing usage. */
  lingerTimer: VoiceTimerHandle | null;
}

/** Grounding the orchestrator wrote, kept so a replacement can be re-grounded. */
interface ContextEntry {
  role: 'system' | 'assistant' | 'user';
  text: string;
  /** Null when the provider accepted the write but issued no handle (Gemini). */
  underlyingId: string | null;
}

const DEFAULT_OPEN_ATTEMPTS = 3;
const DEFAULT_OPEN_RETRY_DELAY_MS = 500;
/**
 * How long a rotation that gave up waits before arming another.
 *
 * A delay rather than an immediate retry: by the time a rotation fails, its
 * pre-arm point is behind it, so rescheduling from the session's open would
 * compute zero and a provider that is refusing connections would be dialled in a
 * hot loop for the rest of the call.
 */
const DEFAULT_REARM_DELAY_MS = 5_000;
const DEFAULT_LINGER_MS = 20_000;
const DEFAULT_GAP_TOLERANCE_MS = 5_000;
/** 8 s of 8 kHz 16-bit mono — longer than any switch, shorter than a whole utterance. */
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 128_000;
/**
 * How long a caller utterance may hold the turn-boundary gate after the last
 * sign of it — a word transcribed, the speech boundary itself — with nothing
 * committing it to the conversation.
 *
 * The gate is held at all because the transcript closing an utterance arrives
 * about a second after the audio, on the connection that heard it. The bound is
 * here because only one of the three providers *reports* speech boundaries: on
 * the other two they are the adapter's own inference, and an inferred start with
 * no utterance behind it — a noise that tripped barge-in — would otherwise hold
 * the gate to the rotation deadline and report a cut that never happened.
 *
 * Generous against the second the commit takes, short against the boundary wait
 * it sits inside (80 s on the default timing), so a real utterance is never the
 * thing this expires on. A caller who genuinely keeps talking keeps renewing it,
 * and is bounded by the rotation deadline like any other blocker.
 */
const CALLER_UTTERANCE_IDLE_MS = 5_000;

/**
 * ## Accounting contract offered to a biller
 *
 * Billing is not implemented here, and rotation deliberately does not bucket, sum
 * or reconcile usage. What it guarantees instead is enough ordering for a biller
 * to be correct given that the two providers measured disagree about what their
 * numbers mean — Gemini reports a per-turn delta that must be summed, Nova a
 * session-cumulative total that must not be:
 *
 * 1. **Every `usage` fact is forwarded, verbatim and in arrival order.** None is
 *    dropped, none is synthesized — including the ones a pre-opened replacement
 *    emits for a replayed transcript before it is ever switched to, and the ones a
 *    superseded session emits after the switch.
 * 2. **Every `usage` fact names its generation.** `UpstreamFact.usage.generation`
 *    is stamped here, counting from 1, so a biller holding a running-total meter
 *    keeps one PER GENERATION and each connection's cumulative figures are billed
 *    from their own zero. This is what makes the linger window safe: a superseded
 *    session's late usage is attributed to the generation that incurred it, not to
 *    the one that happens to be live when it lands — which arrival order cannot
 *    express and `rotation.completed` cannot either.
 * 3. **A rotation re-bills the transcript.** A replayed session pays input tokens
 *    for the whole replayed conversation — measured on Nova, seeding four short
 *    turns cost 446 input text tokens before the caller said anything.
 *    `completed.historyEntries` states how much the live session ended up holding,
 *    so the cost is attributable rather than mysterious. A rotation that had to
 *    dial twice for a current conversation (`abandoned` with `stale-history`) pays
 *    that seeding twice, and both connections' `usage` says so under their own
 *    generation.
 * 4. **`completed.lastUsage`** carries the outgoing session's final known usage at
 *    the instant of the switch, so a biller that only wants a closing figure per
 *    connection has one without tracking the stream.
 */
export class RotatingUpstreamSession implements RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities;
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  #upstream: RealtimeUpstream;
  #baseConfig: UpstreamSessionConfig;
  #onFact: (fact: UpstreamFact) => void;
  #onRotation: (event: RotationEvent) => void;
  #timing: RotationTiming;
  #transcript: VoiceTranscript;
  #schedule: ScheduleVoiceTimer;
  #now: () => number;
  #openAttempts: number;
  #openRetryDelayMs: number;
  #rearmDelayMs: number;
  #lingerMs: number;
  #gapToleranceMs: number;
  #maxBufferedAudioBytes: number;

  #current: Generation;
  #next: Generation | null = null;
  #lingering = new Set<Generation>();
  #phase: RotationPhase = 'live';
  #completedRotations = 0;
  #generationCounter = 1;

  #preArmTimer: VoiceTimerHandle | null = null;
  #boundaryTimer: VoiceTimerHandle | null = null;
  #gapTimer: VoiceTimerHandle | null = null;
  #retryTimer: VoiceTimerHandle | null = null;
  #callerUtteranceTimer: VoiceTimerHandle | null = null;

  /** Turns of the current generation that started and have not ended. */
  #startedTurns = new Set<string>();
  /**
   * Speak requests the provider has not answered yet, and turns it answered with
   * that have not announced themselves. Both are speech the live session owes the
   * caller and neither is visible in `#startedTurns`, so without them the gate
   * opens on an utterance that is already on its way.
   */
  #speechRequests = new Set<number>();
  #speechRequestCounter = 0;
  #awaitedTurns = new Set<string>();
  /**
   * The caller has begun an utterance the live session has not committed to the
   * conversation yet. Bounded by {@link CALLER_UTTERANCE_IDLE_MS}, because two of
   * three providers infer these boundaries rather than report them.
   */
  #callerUtteranceOpen = false;
  /**
   * Tool calls the live session is waiting on results for. Only ever the live
   * generation's: `tool.called` is recorded synchronously from the fact stream,
   * a superseded session's facts are dropped, and the switch clears the set.
   */
  #outstandingToolCalls = new Set<string>();
  /**
   * Which generation minted a turn id, so a stale `cancel` or `truncate` is not
   * applied to a session that never made that turn.
   *
   * A generation rather than a set because `speak` resolves asynchronously: a
   * rotation completing inside that await hands back a turn id belonging to a
   * session that is already gone, and only the recorded generation can tell.
   *
   * The guarantee has a limit worth stating, because provider turn ids are per
   * session and therefore collide: once the new generation mints its own
   * `turn_1`, that id refers to the live turn and a late operation on the old one
   * lands on the new. Closing that hole would mean this wrapper renaming every
   * turn in every fact, which trades a rare ambiguity for permanently breaking
   * correlation with the provider's own logs.
   */
  #turnGenerations = new Map<string, number>();
  #contexts = new Map<string, ContextEntry>();
  #contextCounter = 0;
  #tools: UpstreamToolDefinition[];
  #pendingAudio: Uint8Array[] = [];
  #pendingAudioBytes = 0;
  /**
   * Whether caller audio has reached the generation that is live right now. Reset
   * at every switch, because provider-side priming does not travel: a replacement
   * is seeded with a transcript, which is not audio, and the one provider that
   * requires audio before it will speak needs it again per connection.
   */
  #audioReachedCurrent = false;
  #lastUsage: Record<string, unknown> | null = null;
  #armedBoundaryWaitMs = 0;
  /** The gate was closed at some point in this rotation, so the switch was waited for. */
  #waitedForBoundary = false;
  /** The bounded wait has already expired, so the next legal switch must not wait again. */
  #deadlinePassed = false;
  /**
   * This rotation has already dialled a second time for a current conversation.
   * One re-seed, because the dial itself takes time on a call that keeps talking.
   */
  #reseeded = false;
  #lateUsage = new Map<number, number>();
  /**
   * A generation being opened right now, with the facts it emitted before its
   * `open` resolved. Nova emits `session.opened` from its constructor, so without
   * this the readiness signal for every replacement would be lost and every
   * rotation would wait for its deadline.
   */
  #opening: { index: number; facts: UpstreamFact[] } | null = null;
  /** Which attempt produced the current replacement, so a late death can retry too. */
  #openAttempt = 0;
  /** A `session.closed` held back because a rotation might still rescue the call. */
  #heldClose: Extract<UpstreamFact, { type: 'session.closed' }> | null = null;

  /**
   * Opens the first session and returns a rotating wrapper around it. A failure
   * here is a failure to start the call, and is thrown exactly as
   * `RealtimeUpstream.open` would throw it.
   */
  static async open(options: RotatingUpstreamOptions): Promise<RotatingUpstreamSession> {
    const early: UpstreamFact[] = [];
    let sink: (fact: UpstreamFact) => void = (fact) => {
      early.push(fact);
    };
    const session = await options.upstream.open(options.config, (fact) => sink(fact));
    const rotator = new RotatingUpstreamSession(options, session);
    sink = (fact) => rotator.ingest(1, fact);
    for (const fact of early) {
      rotator.ingest(1, fact);
    }
    return rotator;
  }

  private constructor(options: RotatingUpstreamOptions, session: RealtimeUpstreamSession) {
    this.#upstream = options.upstream;
    this.#baseConfig = options.config;
    this.#onFact = options.onFact;
    this.#onRotation = options.onRotation ?? (() => {});
    this.#timing = resolveRotationTiming(options.upstream.capabilities, options.timing);
    this.#transcript = new VoiceTranscript({
      ...options.transcript,
      seed: options.config.history ?? [],
    });
    this.#schedule = options.scheduleTimer ?? scheduleVoiceTimer;
    this.#now = options.now ?? Date.now;
    this.#openAttempts = Math.max(1, options.openAttempts ?? DEFAULT_OPEN_ATTEMPTS);
    this.#openRetryDelayMs = options.openRetryDelayMs ?? DEFAULT_OPEN_RETRY_DELAY_MS;
    this.#rearmDelayMs = options.rearmDelayMs ?? DEFAULT_REARM_DELAY_MS;
    this.#lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
    this.#gapToleranceMs = options.gapToleranceMs ?? DEFAULT_GAP_TOLERANCE_MS;
    this.#maxBufferedAudioBytes = options.maxBufferedAudioBytes ?? DEFAULT_MAX_BUFFERED_AUDIO_BYTES;
    this.#tools = [...options.config.tools];

    this.capabilities = options.upstream.capabilities;
    this.inputFormat = session.inputFormat;
    this.outputFormat = session.outputFormat;
    this.#current = {
      index: 1,
      session,
      openedAt: this.#now(),
      opened: false,
      dead: false,
      continuity: 'replay',
      historyEntries: options.config.history?.length ?? 0,
      carriedHistory: [...(options.config.history ?? [])],
      tools: this.#tools,
      lingerTimer: null,
    };
    this.#schedulePreArm(this.#current);
  }

  // --------------------------------------------------------------- seam surface

  sendAudio(audio: Uint8Array): void {
    if (this.#phase === 'closed') {
      return;
    }
    const live = this.#liveSession();
    if (!live) {
      this.#bufferAudio(audio);
      return;
    }
    // Bytes, not calls — an empty frame primes nothing on the provider either.
    this.#audioReachedCurrent = this.#audioReachedCurrent || audio.byteLength > 0;
    live.sendAudio(audio);
  }

  sendText(text: string, callerItemId: string): void {
    if (this.#phase === 'closed') {
      return;
    }
    const live = this.#liveSession();
    if (!live) {
      logger.warn('[RotatingUpstream] caller text dropped: no live session', {
        callerItemId,
        phase: this.#phase,
      });
      return;
    }
    live.sendText(text, callerItemId);
  }

  /**
   * Delegated to whichever session is live. Not queued across a rotation gap:
   * whether an utterance that could not be spoken should be retried later is
   * scheduling policy the orchestrator owns, and the seam already defines a
   * refusal as `null` rather than as an error.
   *
   * One refusal is this wrapper's own, and it is the reason rotation cannot be
   * fully invisible: on an upstream declaring `canSpeakBeforeFirstInput: false`, a
   * replacement connection starts in that state no matter how long the call has
   * been running, so the first utterance after a switch is refused until caller
   * audio has reached that generation. The adapter would refuse it anyway — this
   * states the same fact one layer earlier, where the generation is nameable,
   * rather than letting an orchestrator read "the provider declined" and wonder why
   * a mid-call narration behaves like a cold session.
   *
   * It does not fire for an adapter that primes its own container at open (Nova 2):
   * that upstream declares true, and its replacements are primed by the same `open`
   * this rotator calls.
   *
   * The other refusal is a rotation that happened inside the round trip. `null` is
   * the only honest answer there: the turn belongs to a connection that is gone,
   * so it will never start, never end and never play, and an orchestrator holding
   * its id waits for an ending that cannot arrive — which on a manager that tracks
   * one turn at a time is silence for the rest of the call. The gate normally
   * waits for an accepted request rather than cutting it — that is the
   * `speech-requested` {@link RotationBlocker} — so this is only reachable where
   * the bounded wait ran out.
   */
  async speak(request: SpeakRequest): Promise<string | null> {
    const live = this.#liveSession();
    if (!live) {
      logger.warn('[RotatingUpstream] speech refused: no live session', {
        reason: request.reason,
        phase: this.#phase,
      });
      return null;
    }
    if (!this.capabilities.canSpeakBeforeFirstInput && !this.#audioReachedCurrent) {
      logger.warn('[RotatingUpstream] speech refused: this connection has heard nothing yet', {
        reason: request.reason,
        generation: this.#current.index,
        completedRotations: this.#completedRotations,
      });
      return null;
    }
    const generation = this.#current.index;
    const requestId = this.#openSpeechRequest();
    try {
      const turnId = await live.speak(request);
      return turnId !== null && this.#claimMintedTurn(turnId, generation) ? turnId : null;
    } finally {
      this.#closeSpeechRequest(requestId);
    }
  }

  /**
   * Speech the provider has been asked for and has not answered.
   *
   * Registered before the round trip because that is the window the turn exists
   * in nowhere: `speak` has been accepted, `model.turn.started` has not arrived,
   * and a switch in between leaves the whole utterance — its start, its audio and
   * its end — arriving on a session that has been superseded, where every frame is
   * dropped and nothing re-issues them.
   */
  #openSpeechRequest(): number {
    this.#speechRequestCounter += 1;
    this.#speechRequests.add(this.#speechRequestCounter);
    return this.#speechRequestCounter;
  }

  /**
   * The request has been answered, one way or another. Ids are unique for the
   * whole call, so a request a switch already discarded cannot release anything
   * the live generation is waiting on.
   */
  #closeSpeechRequest(requestId: number): void {
    if (this.#speechRequests.delete(requestId)) {
      this.#considerSwitch();
    }
  }

  /**
   * Only the generation that is still live may claim a turn id.
   *
   * `speak` is a round trip, so a rotation can complete inside it — and because
   * adapters number turns per session, the id coming back is one the NEW
   * generation may already have minted for a turn of its own. Writing the dead
   * generation over that mapping makes {@link RotatingUpstreamSession.cancel}
   * refuse the caller's next barge-in on a turn that is genuinely live, which is
   * the opposite of what the map exists for.
   *
   * A claimed turn keeps holding the boundary gate until it announces itself,
   * since a turn that has been promised and not started is as much an utterance
   * in flight as one already playing. Not for a turn that announced itself while
   * `speak` was still resolving, though — that one is already accounted for, and
   * one that also already ended must not be waited for a second time.
   */
  #claimMintedTurn(turnId: string, generation: number): boolean {
    if (generation !== this.#current.index) {
      logger.warn('[RotatingUpstream] a speak resolved after its generation was replaced', {
        turnId,
        generation,
        current: this.#current.index,
      });
      return false;
    }
    if (!this.#turnGenerations.has(turnId)) {
      this.#awaitedTurns.add(turnId);
    }
    this.#turnGenerations.set(turnId, generation);
    return true;
  }

  /**
   * Records the result in the transcript, then delivers it — but only to the
   * generation that asked for it.
   *
   * A result carried across a rotation is not merely useless: Nova rejects an
   * unknown `toolUseId` with a `ValidationException` that kills the stream. A
   * rotation only ever crosses an outstanding tool call when the bounded wait
   * expired, which is already reported as its own fault.
   */
  submitToolResult(callId: string, output: string): void {
    // Recorded before the routing check on purpose: the tool really did run and
    // really did return this, so even a result that can no longer be delivered
    // belongs in the transcript and reaches the model at the next rotation.
    this.#transcript.recordToolResult(callId, output);
    if (!this.#outstandingToolCalls.delete(callId)) {
      logger.warn('[RotatingUpstream] dropping a tool result the live session cannot accept', {
        callId,
        reason: 'the call was made by a session that has since been replaced, or never made at all',
        generation: this.#current.index,
      });
      return;
    }
    this.#current.session.submitToolResult(callId, output);
    this.#considerSwitch();
  }

  close(): void {
    if (this.#phase === 'closed') {
      return;
    }
    this.#phase = 'closed';
    this.#cancelTimers();
    this.#next?.session.close();
    this.#next = null;
    for (const generation of this.#lingering) {
      generation.lingerTimer?.cancel();
      generation.session.close();
    }
    this.#lingering.clear();
    this.#current.session.close();
  }

  /** Requires `hardCancel`. Ignored for a turn the live session did not mint. */
  cancel(turnId: string): void {
    if (!this.capabilities.hardCancel) {
      logger.warn('[RotatingUpstream] cancel on a provider without hardCancel', { turnId });
      return;
    }
    if (!this.#ownsTurn(turnId)) {
      return;
    }
    this.#current.session.cancel?.(turnId);
  }

  /** Requires `truncateAtPlayback`. Ignored for a turn the live session did not mint. */
  truncate(turnId: string, playedMs: number): void {
    if (!this.capabilities.truncateAtPlayback) {
      logger.warn('[RotatingUpstream] truncate on a provider without truncateAtPlayback', {
        turnId,
      });
      return;
    }
    if (!this.#ownsTurn(turnId)) {
      return;
    }
    this.#current.session.truncate?.(turnId, playedMs);
  }

  /**
   * Requires `mutableConversation`. Written to the live session and kept, so a
   * replacement can be re-grounded — grounding does not travel in
   * `UpstreamSessionConfig.history`, which carries only the conversation, so
   * without this a rotation silently drops every screen state and delivered
   * result the orchestrator had written.
   *
   * The returned id is this rotator's own, mapped to the live session's, which is
   * what makes `removeContext` survive a rotation. Null is returned when the
   * provider issued no handle, preserving the seam's rule that `removeContext` is
   * valid only for ids `appendContext` returned; the entry is still replayed.
   */
  appendContext(role: 'system' | 'assistant' | 'user', text: string): string | null {
    if (!this.capabilities.mutableConversation) {
      logger.warn('[RotatingUpstream] appendContext on an immutable conversation', { role });
      return null;
    }
    const underlyingId = this.#liveSession()?.appendContext?.(role, text) ?? null;
    this.#contextCounter += 1;
    const id = `ctx_${this.#contextCounter}`;
    this.#contexts.set(id, { role, text, underlyingId });
    return underlyingId === null ? null : id;
  }

  /** Requires `mutableConversation`, and only for ids `appendContext` returned. */
  removeContext(id: string): void {
    const entry = this.#contexts.get(id);
    if (!entry) {
      return;
    }
    this.#contexts.delete(id);
    if (entry.underlyingId !== null) {
      this.#liveSession()?.removeContext?.(entry.underlyingId);
    }
  }

  /** Requires `mutableTools`. Remembered, so a replacement opens with the current list. */
  setTools(tools: UpstreamToolDefinition[]): void {
    if (!this.capabilities.mutableTools) {
      logger.warn('[RotatingUpstream] setTools on a provider without mutableTools');
      return;
    }
    this.#tools = [...tools];
    this.#liveSession()?.setTools?.(this.#tools);
  }

  /** Requires `sessionResumption`. */
  resumptionHandle(): string | null {
    return this.#liveSession()?.resumptionHandle?.() ?? null;
  }

  // -------------------------------------------------------------- observability

  state(): RotationState {
    return {
      generation: this.#current.index,
      phase: this.#phase,
      replacementReady: this.#next?.opened === true,
      blockers: this.#blockers(),
      completedRotations: this.#completedRotations,
      lingeringSessions: this.#lingering.size,
      bufferedAudioBytes: this.#pendingAudioBytes,
    };
  }

  /** The conversation a replacement would be seeded with right now. */
  transcript(): TranscriptEntry[] {
    return this.#transcript.entries();
  }

  // ------------------------------------------------------------- fact ingestion

  /**
   * Every generation's facts arrive here tagged with the generation that produced
   * them, which is what makes a pre-opened session's frames and a superseded
   * session's frames separable from the live conversation.
   *
   * Public only so {@link RotatingUpstreamSession.open} can wire the first
   * session's callback before the instance exists.
   */
  ingest(generationIndex: number, fact: UpstreamFact): void {
    const attributed = attributeUsage(generationIndex, fact);
    if (attributed.type === 'usage') {
      this.#lastUsage = attributed.raw;
    }
    if (generationIndex === this.#current.index) {
      this.#ingestCurrent(attributed);
      return;
    }
    if (this.#next && generationIndex === this.#next.index) {
      this.#ingestReplacement(this.#next, attributed);
      return;
    }
    if (this.#opening?.index === generationIndex) {
      this.#opening.facts.push(attributed);
      return;
    }
    this.#ingestSuperseded(generationIndex, attributed);
  }

  #ingestCurrent(fact: UpstreamFact): void {
    this.#transcript.observe(fact);
    switch (fact.type) {
      case 'session.opened':
        this.#current.opened = true;
        // Generation 2+ opening is not the call starting. Forwarding it would
        // make the orchestrator greet a caller it already greeted.
        if (this.#current.index === 1) {
          this.#onFact(fact);
        }
        return;
      case 'session.ending':
        // Consumed, never forwarded: this wrapper exists so nothing above it has
        // to react to a cap.
        this.#arm('provider-warning', fact.inMs);
        return;
      case 'session.closed':
        this.#onCurrentClosed(fact);
        return;
      case 'model.turn.started':
        this.#awaitedTurns.delete(fact.turnId);
        this.#startedTurns.add(fact.turnId);
        this.#turnGenerations.set(fact.turnId, this.#current.index);
        this.#onFact(fact);
        return;
      case 'model.turn.ended':
        // Deleted from both: a turn the provider ends without ever starting it
        // is speech that is not coming, and must not keep holding the gate.
        this.#awaitedTurns.delete(fact.turnId);
        this.#startedTurns.delete(fact.turnId);
        this.#onFact(fact);
        this.#considerSwitch();
        return;
      case 'caller.speech.started':
        this.#openCallerUtterance();
        this.#onFact(fact);
        return;
      case 'caller.speech.stopped':
      case 'caller.transcript':
        this.#renewCallerUtterance();
        this.#onFact(fact);
        return;
      case 'caller.turn.committed':
        // Forwarded before the gate is reconsidered, and that order is
        // load-bearing: on a provider whose turns the orchestrator drives, this
        // fact is what makes it ask for a reply, and the request has to be
        // registered before the switch is weighed or the reply is orphaned.
        this.#onFact(fact);
        this.#endCallerUtterance();
        this.#considerSwitch();
        return;
      case 'tool.called':
        this.#outstandingToolCalls.add(fact.callId);
        this.#onFact(fact);
        return;
      default:
        this.#onFact(fact);
    }
  }

  /**
   * The caller has the floor. Their audio is going to the session that is live
   * now, and the transcript that closes the utterance comes back on that same
   * connection — so a switch in between splits the utterance in two and the half
   * the outgoing session heard is dropped with it. On a provider whose turns the
   * orchestrator drives, the dropped `caller.turn.committed` also means the
   * question is never answered at all.
   */
  #openCallerUtterance(): void {
    this.#callerUtteranceOpen = true;
    this.#renewCallerUtterance();
  }

  /**
   * A word transcribed or a speech boundary reported is the utterance still
   * going. Only ever extends one that is already open: on the provider that
   * reports real boundaries the final transcript arrives *after* the commit, and
   * opening an utterance on it would hold the gate against an utterance that is
   * already in the conversation.
   */
  #renewCallerUtterance(): void {
    if (!this.#callerUtteranceOpen) {
      return;
    }
    this.#callerUtteranceTimer?.cancel();
    this.#callerUtteranceTimer = this.#schedule(
      () => this.#onCallerUtteranceIdle(),
      CALLER_UTTERANCE_IDLE_MS,
    );
  }

  #onCallerUtteranceIdle(): void {
    this.#callerUtteranceTimer = null;
    if (!this.#callerUtteranceOpen) {
      return;
    }
    logger.info('[RotatingUpstream] no longer holding the rotation for the caller', {
      reason: 'speech was reported to have started and nothing committed it to the conversation',
      generation: this.#current.index,
    });
    this.#callerUtteranceOpen = false;
    this.#considerSwitch();
  }

  #endCallerUtterance(): void {
    this.#callerUtteranceTimer?.cancel();
    this.#callerUtteranceTimer = null;
    this.#callerUtteranceOpen = false;
  }

  /**
   * A pre-opened replacement is not on the call yet. Its `usage` still is —
   * seeding a transcript is billed the moment the session opens — so that is
   * forwarded and everything else dropped. Nothing else should arrive: no audio
   * is sent to it, and both providers that seed history do so without requesting
   * a generation (Gemini `turnComplete: false`, Nova `interactive: false`).
   */
  #ingestReplacement(replacement: Generation, fact: UpstreamFact): void {
    if (fact.type === 'usage') {
      this.#onFact(fact);
      return;
    }
    if (fact.type === 'session.opened') {
      replacement.opened = true;
      this.#considerSwitch();
      return;
    }
    if (fact.type === 'session.closed') {
      this.#onReplacementLost(replacement, 'the replacement closed before it was used');
      return;
    }
    if (fact.type === 'fault' && !fact.recoverable) {
      this.#onReplacementLost(replacement, `${fact.code}: ${fact.message}`);
      return;
    }
    logger.debug('[RotatingUpstream] dropped a fact from a not-yet-live session', {
      generation: replacement.index,
      factType: fact.type,
    });
  }

  /**
   * A superseded session still owes money. Its `usage` is forwarded and nothing
   * else is: its audio would talk over the live session, and its `session.closed`
   * is this wrapper's own doing.
   */
  #ingestSuperseded(generationIndex: number, fact: UpstreamFact): void {
    if (fact.type !== 'usage') {
      logger.debug('[RotatingUpstream] dropped a fact from a superseded session', {
        generation: generationIndex,
        factType: fact.type,
      });
      return;
    }
    this.#lateUsage.set(generationIndex, (this.#lateUsage.get(generationIndex) ?? 0) + 1);
    this.#onFact(fact);
  }

  /**
   * The live connection ended. Whether that is the end of the call depends on
   * whether a rotation is in flight: during one, the close is the cap arriving
   * early and must not reach the orchestrator, which would tear down a call that
   * is about to be handed to a replacement.
   */
  #onCurrentClosed(fact: Extract<UpstreamFact, { type: 'session.closed' }>): void {
    this.#current.dead = true;
    this.#dropInFlightWork();
    if (this.#phase === 'live' || this.#phase === 'closed') {
      this.#phase = 'closed';
      this.#cancelTimers();
      this.#onFact(fact);
      return;
    }
    this.#heldClose = fact;
    this.#onFact({
      type: 'fault',
      code: 'rotation_gap',
      message: 'the connection ended before its replacement was ready; caller audio is buffered',
      recoverable: true,
    });
    this.#gapTimer?.cancel();
    this.#gapTimer = this.#schedule(() => this.#onGapExpired(), this.#gapToleranceMs);
    this.#considerSwitch();
  }

  /** No replacement arrived in time. An honest hangup beats an open, silent line. */
  #onGapExpired(): void {
    const held = this.#heldClose;
    if (!held || this.#phase === 'closed') {
      return;
    }
    this.#heldClose = null;
    this.#phase = 'closed';
    this.#cancelTimers();
    this.#next?.session.close();
    this.#next = null;
    this.#emitRotation({ type: 'abandoned', generation: this.#current.index, reason: 'closed' });
    this.#onFact(held);
  }

  // ------------------------------------------------------------------- rotation

  /**
   * Schedules the pre-arm from the moment this session *opened*, not from the
   * moment it became live. A replacement is pre-opened up to a boundary wait
   * before the switch, so its cap is already running when it takes over; timing
   * the next rotation from the switch would overshoot by however long the
   * previous boundary wait lasted.
   */
  #schedulePreArm(generation: Generation): void {
    const preArmAfterMs = this.#timing.preArmAfterMs;
    if (preArmAfterMs === null) {
      return;
    }
    const elapsed = this.#now() - generation.openedAt;
    this.#preArmTimer?.cancel();
    this.#preArmTimer = this.#schedule(
      () => this.#arm('local-timer', null),
      Math.max(0, preArmAfterMs - elapsed),
    );
  }

  /**
   * Decide to rotate. Idempotent within one rotation: a provider warning landing
   * after the local timer already armed us only tightens the deadline, because
   * the reason to arm early is to have a wait to spend and two arms would spend
   * it twice.
   */
  #arm(trigger: RotationTrigger, providerInMs: number | null): void {
    if (this.#phase === 'closed') {
      return;
    }
    const boundaryWaitMs = boundaryWaitFor(providerInMs, this.#timing);
    if (this.#phase !== 'live') {
      this.#tightenBoundaryWait(boundaryWaitMs);
      return;
    }
    this.#phase = 'armed';
    this.#armedBoundaryWaitMs = boundaryWaitMs;
    this.#waitedForBoundary = false;
    this.#deadlinePassed = false;
    this.#reseeded = false;
    this.#preArmTimer?.cancel();
    this.#preArmTimer = null;
    this.#boundaryTimer = this.#schedule(() => this.#onBoundaryDeadline(), boundaryWaitMs);
    this.#emitRotation({
      type: 'armed',
      generation: this.#current.index,
      trigger,
      providerInMs,
      boundaryWaitMs,
    });
    void this.#openReplacement(1);
  }

  #tightenBoundaryWait(boundaryWaitMs: number): void {
    if (boundaryWaitMs >= this.#armedBoundaryWaitMs) {
      return;
    }
    this.#armedBoundaryWaitMs = boundaryWaitMs;
    this.#boundaryTimer?.cancel();
    this.#boundaryTimer = this.#schedule(() => this.#onBoundaryDeadline(), boundaryWaitMs);
  }

  async #openReplacement(attempt: number): Promise<void> {
    if (this.#phase === 'closed' || this.#next !== null || this.#opening !== null) {
      return;
    }
    const continuity = this.#chooseContinuity();
    const config = this.#replacementConfig(continuity);
    const index = this.#generationCounter + 1;
    // What this session will hold the moment it opens. On the replay path that
    // is the seeded transcript; on the resumption path it is what the handle is
    // assumed to restore. Either way, everything recorded after this point is
    // conversation the new session has never been told.
    const carriedHistory = config.history ?? this.#transcript.entries();
    const historyEntries = config.history?.length ?? 0;
    const tools = this.#tools;
    this.#opening = { index, facts: [] };
    this.#openAttempt = attempt;
    this.#emitRotation({ type: 'opening', generation: index, attempt, continuity, historyEntries });
    try {
      const session = await this.#upstream.open(config, (fact) => this.ingest(index, fact));
      this.#adoptReplacement({
        index,
        session,
        continuity,
        historyEntries,
        carriedHistory,
        tools,
      });
    } catch (error) {
      this.#opening = null;
      this.#onOpenFailed(index, attempt, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * A replacement whose negotiated formats differ from the live session's is
   * refused rather than used. Mismatched audio produces no error anywhere — just
   * noise on the call, found by a human listening — which is precisely the
   * failure the seam made observable, so it will not be re-introduced here.
   */
  #adoptReplacement(params: {
    index: number;
    session: RealtimeUpstreamSession;
    continuity: ContinuityStrategy;
    historyEntries: number;
    carriedHistory: ReadonlyArray<TranscriptEntry>;
    tools: UpstreamToolDefinition[];
  }): void {
    const early = this.#opening?.index === params.index ? this.#opening.facts : [];
    this.#opening = null;
    if (this.#phase === 'closed') {
      params.session.close();
      return;
    }
    if (!this.#formatsMatch(params.session)) {
      params.session.close();
      this.#onFormatMismatch(params.index, params.session);
      return;
    }
    this.#generationCounter = params.index;
    this.#next = {
      index: params.index,
      session: params.session,
      openedAt: this.#now(),
      opened: false,
      dead: false,
      continuity: params.continuity,
      historyEntries: params.historyEntries,
      carriedHistory: params.carriedHistory,
      tools: params.tools,
      lingerTimer: null,
    };
    for (const fact of early) {
      this.ingest(params.index, fact);
    }
    this.#considerSwitch();
  }

  #formatsMatch(session: RealtimeUpstreamSession): boolean {
    return (
      sameAudioFormat(session.inputFormat, this.inputFormat) &&
      sameAudioFormat(session.outputFormat, this.outputFormat)
    );
  }

  /**
   * The rotation is over and the live session keeps the call — unless it is the
   * dead line this rotation was rescuing, in which case the withheld
   * `session.closed` is released and the call ends now.
   *
   * Order matters and is the same as {@link RotatingUpstreamSession.#onOpenFailed}'s:
   * `#onGapExpired` is what releases that close, and it declines to act once the
   * phase is already `closed`. Closing the phase first therefore swallows the
   * close, and nothing above ever learns the connection is gone.
   */
  #onFormatMismatch(index: number, session: RealtimeUpstreamSession): void {
    this.#onFact({
      type: 'fault',
      code: 'rotation_format_mismatch',
      message: `the replacement negotiated ${describeFormats(session)} where the live session holds ${describeFormats(this)}`,
      recoverable: false,
    });
    this.#emitRotation({ type: 'abandoned', generation: index, reason: 'format-mismatch' });
    if (this.#heldClose) {
      this.#onGapExpired();
      return;
    }
    this.#returnToLive();
  }

  #onOpenFailed(index: number, attempt: number, message: string): void {
    const willRetry = attempt < this.#openAttempts && this.#phase !== 'closed';
    this.#emitRotation({
      type: 'open-failed',
      generation: index,
      attempt,
      error: message,
      willRetry,
    });
    if (willRetry) {
      this.#retryTimer?.cancel();
      this.#retryTimer = this.#schedule(
        () => void this.#openReplacement(attempt + 1),
        this.#openRetryDelayMs,
      );
      return;
    }
    this.#emitRotation({ type: 'abandoned', generation: index, reason: 'open-exhausted' });
    this.#onFact({
      type: 'fault',
      code: 'rotation_open_failed',
      message: `no replacement session could be opened: ${message}`,
      recoverable: false,
    });
    if (this.#heldClose) {
      this.#onGapExpired();
      return;
    }
    this.#returnToLive();
  }

  /**
   * The rotation failed and the call goes on. The phase returns to `live` so a
   * later attempt is possible at all, and a fresh pre-arm makes one happen.
   *
   * Without the re-arm this is where rotation quietly ends for the rest of the
   * call: `#arm` cancels the pre-arm timer on the way in, so one transient
   * connect failure would leave a rotating call to reach the provider's cap and
   * be cut off, with only the earlier `recoverable: false` fault as warning.
   */
  #returnToLive(): void {
    if (this.#phase === 'closed') {
      // The dial that just failed was in flight when the call ended. There is no
      // live session to return to, and re-arming would dial against a hangup.
      return;
    }
    this.#boundaryTimer?.cancel();
    this.#boundaryTimer = null;
    this.#phase = 'live';
    this.#scheduleRearm();
  }

  /**
   * Spaced by {@link DEFAULT_REARM_DELAY_MS} rather than scheduled from the
   * session's open, because the pre-arm point is already behind us and
   * rescheduling from it computes zero — which against a provider that is
   * refusing connections is a hot loop for the rest of the call. The pre-arm
   * point still wins where a rotation somehow failed before it.
   */
  #scheduleRearm(): void {
    const preArmAfterMs = this.#timing.preArmAfterMs;
    const remaining =
      preArmAfterMs === null ? 0 : preArmAfterMs - (this.#now() - this.#current.openedAt);
    this.#preArmTimer?.cancel();
    this.#preArmTimer = this.#schedule(
      () => this.#arm('local-timer', null),
      Math.max(this.#rearmDelayMs, remaining),
    );
  }

  /**
   * The replacement died before it was used. Treated as exactly the same failure
   * as an open that rejected, retries included — a connection that opened and
   * then dropped is no less recoverable than one that never opened, and treating
   * them differently would make a rotation's resilience depend on which side of
   * the handshake the provider failed on.
   */
  #onReplacementLost(replacement: Generation, message: string): void {
    if (this.#next !== replacement) {
      return;
    }
    this.#next = null;
    replacement.session.close();
    this.#onOpenFailed(replacement.index, this.#openAttempt, message);
  }

  /**
   * Resumption is only chosen when a handle actually exists. Gemini warns with
   * `goAway` from early in a connection but only issues a handle alongside a
   * turn, so a rotation before the first turn holds a capability it cannot use —
   * and replaying is the correct answer there, not resuming from nothing.
   */
  #chooseContinuity(): ContinuityStrategy {
    if (continuityStrategy(this.capabilities) === 'replay') {
      return 'replay';
    }
    return this.#currentResumptionHandle() === null ? 'replay' : 'resume';
  }

  #currentResumptionHandle(): string | null {
    return this.#current.session.resumptionHandle?.() ?? null;
  }

  /**
   * Continuity is either the provider's handle or a replayed transcript, never
   * both: a resumed session already holds the conversation, and seeding it again
   * reads to the model as the caller having said everything twice.
   */
  #replacementConfig(continuity: ContinuityStrategy): UpstreamSessionConfig {
    const config: UpstreamSessionConfig = { ...this.#baseConfig, tools: this.#tools };
    delete config.history;
    delete config.resumptionHandle;
    if (continuity === 'resume') {
      const handle = this.#currentResumptionHandle();
      if (handle !== null) {
        config.resumptionHandle = handle;
      }
      return config;
    }
    config.history = this.#transcript.entries();
    return config;
  }

  /**
   * The conversation a replacement has not been told.
   *
   * A replacement is seeded when the rotation arms and switched to once the model
   * stops speaking — a whole boundary wait later, 80 s on the default timing. The
   * entries in between are the ones that matter most: the model's own last answer
   * and the caller's last question. Handing a session that gap is how a rotated
   * model repeats itself or loses the thread.
   *
   * Compared by value rather than by count, so an entry that was seeded and then
   * *changed* — a tool line whose result landed after the seed — counts as
   * missing too.
   *
   * A transcript trimmed to its budget since the seed is the case with no shared
   * prefix at all: trimming drops the oldest entries, so what the replacement
   * holds has fallen off the front of the conversation rather than staying at the
   * head of it. What it has not been told is then everything after the point
   * where the carried tail rejoins the current head — the whole of the current
   * transcript once the two no longer overlap, since by then not one entry the
   * replacement holds is still in it. Nothing is re-sent that the replacement
   * already has, which is what would read to the model as the caller having said
   * everything twice.
   *
   * Reaching this on default budgets takes 200 entries or 100 KB, which ordinary
   * conversation produces and only long calls — the ones that rotate — ever get
   * near.
   */
  #historyDelta(replacement: Generation): TranscriptEntry[] {
    const current = this.#transcript.entries();
    const carried = replacement.carriedHistory;
    const matched = commonPrefixLength(carried, current);
    if (matched > 0 || carried.length === 0) {
      return current.slice(matched);
    }
    return current.slice(tailOverlapLength(carried, current));
  }

  /**
   * Writes the delta into the replacement, where the provider allows the
   * conversation to be written at all.
   *
   * Where it does not, the switch is happening with a conversation that stops
   * short and nothing can change that now — `#needsFreshSeed` re-seeds where
   * there was still room to, and this is the path where there was not: a
   * deadline, a dead line, or a re-seed already spent. The orchestrator is told,
   * because a model that is about to repeat its last answer is a fact about the
   * call rather than a detail of rotation.
   */
  #topUpHistory(replacement: Generation): number {
    const delta = this.#historyDelta(replacement);
    if (delta.length === 0) {
      return 0;
    }
    if (!this.capabilities.mutableConversation) {
      this.#onFact({
        type: 'fault',
        code: 'rotation_history_incomplete',
        message: `the replacement was seeded before the last ${delta.length} thing(s) said, and this provider accepts conversation only at open`,
        recoverable: true,
      });
      return 0;
    }
    for (const entry of delta) {
      replacement.session.appendContext?.(entry.role, entry.text);
    }
    return delta.length;
  }

  /**
   * Whether the replacement has to be dialled again to hold a current
   * conversation. Only where the provider offers no way to write one: Nova
   * accepts an assistant write mid-session and silently discards it, which is why
   * it declares `mutableConversation: false` and why a top-up cannot rescue it.
   *
   * Not on the resumption path — that session restores its own state — and at
   * most once per rotation, since the second dial takes time of its own and the
   * bounded wait, not this, decides when the rotation has to happen regardless.
   */
  #needsFreshSeed(replacement: Generation): boolean {
    if (this.#reseeded || this.capabilities.mutableConversation) {
      return false;
    }
    if (replacement.continuity !== 'replay') {
      return false;
    }
    return this.#historyDelta(replacement).length > 0;
  }

  /**
   * Drops the session seeded at the arm and dials one holding the conversation as
   * it stands. The old connection is still live and still carrying the call, so
   * this costs a dial rather than a gap the caller can hear.
   */
  #reseedReplacement(replacement: Generation): void {
    this.#reseeded = true;
    this.#next = null;
    replacement.session.close();
    this.#emitRotation({
      type: 'abandoned',
      generation: replacement.index,
      reason: 'stale-history',
    });
    void this.#openReplacement(1);
  }

  /**
   * Work the outgoing connection has not finished. Each entry is bounded by the
   * rotation deadline rather than waited on forever — a model that never stops
   * speaking, a tool result that never comes back and a caller who never draws
   * breath all end the same way, with `rotation_cut_mid_turn` and a switch.
   */
  #blockers(): RotationBlocker[] {
    const blockers: RotationBlocker[] = [];
    if (this.#startedTurns.size > 0) {
      blockers.push('model-speaking');
    }
    if (this.#speechRequests.size > 0 || this.#awaitedTurns.size > 0) {
      blockers.push('speech-requested');
    }
    if (this.#callerUtteranceOpen) {
      blockers.push('caller-speaking');
    }
    if (this.#outstandingToolCalls.size > 0) {
      blockers.push('tool-outstanding');
    }
    return blockers;
  }

  /**
   * Everything in flight belongs to the connection that is going away: a turn it
   * started, speech it accepted and never began, an utterance whose transcript
   * would have come back on it. None of it can complete now, and keeping it would
   * hold the next switch on work no session is doing.
   */
  #dropInFlightWork(): void {
    this.#startedTurns.clear();
    this.#speechRequests.clear();
    this.#awaitedTurns.clear();
    this.#endCallerUtterance();
  }

  /**
   * The turn-boundary gate. Called from everything that could open a boundary — a
   * replacement becoming ready, a turn ending, a speak request being answered, a
   * caller utterance reaching the conversation, a tool result being returned, the
   * live session dying — so the switch happens at the first legal moment rather
   * than on a poll.
   */
  #considerSwitch(): void {
    const replacement = this.#next;
    if (!replacement?.opened || this.#phase === 'closed' || this.#phase === 'live') {
      return;
    }
    if (this.#current.dead) {
      this.#switch(replacement, 'session-lost');
      return;
    }
    // A replacement that only became ready after the deadline must not start a
    // fresh wait: the wait is already spent and the timer is not coming back.
    if (this.#deadlinePassed) {
      this.#switchAtDeadline(replacement);
      return;
    }
    const blockers = this.#blockers();
    if (blockers.length === 0) {
      if (this.#needsFreshSeed(replacement)) {
        this.#reseedReplacement(replacement);
        return;
      }
      this.#switch(replacement, this.#waitedForBoundary ? 'turn-ended' : 'idle');
      return;
    }
    this.#waitedForBoundary = true;
    if (this.#phase !== 'awaiting-boundary') {
      this.#phase = 'awaiting-boundary';
      this.#emitRotation({
        type: 'awaiting-boundary',
        generation: this.#current.index,
        blockers,
        boundaryWaitMs: this.#armedBoundaryWaitMs,
      });
    }
  }

  /**
   * The bound on the turn-boundary wait. Rotating over a speaking model cuts the
   * utterance, which is exactly what the wait exists to avoid — but the
   * alternative is the cap arriving first and cutting it anyway with no report.
   * So the switch happens and the truth is told twice: as the rotation's
   * `boundary: 'deadline'` and as a `fault` the orchestrator can act on.
   */
  #onBoundaryDeadline(): void {
    if (this.#phase === 'closed' || this.#phase === 'live') {
      return;
    }
    this.#deadlinePassed = true;
    const replacement = this.#next;
    if (!replacement?.opened) {
      this.#onFact({
        type: 'fault',
        code: 'rotation_deadline_without_replacement',
        message:
          'the session cap is imminent and no replacement is ready; the connection may drop mid-call',
        recoverable: true,
      });
      return;
    }
    this.#switchAtDeadline(replacement);
  }

  #switchAtDeadline(replacement: Generation): void {
    const blockers = this.#blockers();
    if (blockers.length > 0) {
      this.#onFact({
        type: 'fault',
        code: 'rotation_cut_mid_turn',
        message: `rotating with ${blockers.join(' and ')} because the session cap left no more room to wait`,
        recoverable: true,
      });
    }
    this.#switch(replacement, blockers.length > 0 ? 'deadline' : 'turn-ended');
  }

  #switch(replacement: Generation, boundary: RotationBoundary): void {
    const outgoing = this.#current;
    const lastUsage = this.#lastUsage;
    this.#boundaryTimer?.cancel();
    this.#boundaryTimer = null;
    this.#gapTimer?.cancel();
    this.#gapTimer = null;
    this.#retryTimer?.cancel();
    this.#retryTimer = null;
    this.#heldClose = null;
    this.#next = null;
    this.#current = replacement;
    this.#phase = 'live';
    this.#deadlinePassed = false;
    this.#waitedForBoundary = false;
    this.#completedRotations += 1;
    this.#dropInFlightWork();
    this.#audioReachedCurrent = false;
    this.#reseeded = false;
    const carried = replacement.historyEntries + this.#topUpHistory(replacement);
    this.#transcript.beginGeneration();
    this.#forgetGeneration(outgoing.index);
    this.#regroundReplacement(replacement);
    this.#flushBufferedAudio(replacement);
    this.#emitRotation({
      type: 'completed',
      fromGeneration: outgoing.index,
      toGeneration: replacement.index,
      boundary,
      continuity: replacement.continuity,
      historyEntries: carried,
      lastUsage,
    });
    this.#linger(outgoing);
    this.#schedulePreArm(replacement);
  }

  /**
   * Tool calls and turn ids the outgoing session minted can never be honoured —
   * the provider that issued them is gone. Dropping them is what lets
   * `#blockers` become empty again, and what stops a late result being posted to
   * a session that would reject it.
   */
  #forgetGeneration(outgoingIndex: number): void {
    this.#outstandingToolCalls.clear();
    for (const [turnId, generation] of [...this.#turnGenerations]) {
      if (generation === outgoingIndex) {
        this.#turnGenerations.delete(turnId);
      }
    }
  }

  /**
   * Re-applies the grounding ledger and, where the tool list changed after the
   * replacement was opened, the tools. Both would otherwise silently revert:
   * grounding does not travel in `history`, and a session opened before a
   * `setTools` call holds the older list.
   */
  #regroundReplacement(replacement: Generation): void {
    if (replacement.tools !== this.#tools && this.capabilities.mutableTools) {
      replacement.session.setTools?.(this.#tools);
    }
    if (!this.capabilities.mutableConversation) {
      return;
    }
    for (const entry of this.#contexts.values()) {
      entry.underlyingId = replacement.session.appendContext?.(entry.role, entry.text) ?? null;
    }
  }

  // ------------------------------------------------------------------- plumbing

  #liveSession(): RealtimeUpstreamSession | null {
    if (this.#phase === 'closed' || this.#current.dead) {
      return null;
    }
    return this.#current.session;
  }

  #ownsTurn(turnId: string): boolean {
    const generation = this.#turnGenerations.get(turnId);
    if (generation === this.#current.index) {
      return true;
    }
    logger.warn('[RotatingUpstream] ignoring an operation on a superseded turn', {
      turnId,
      generation,
      current: this.#current.index,
    });
    return false;
  }

  /**
   * Caller audio arriving with no live session. Dropping the oldest keeps the end
   * of the caller's sentence, which is the half the model needs in order to
   * answer; dropping the newest would answer a question that had moved on.
   */
  #bufferAudio(audio: Uint8Array): void {
    this.#pendingAudio.push(audio);
    this.#pendingAudioBytes += audio.byteLength;
    while (this.#pendingAudioBytes > this.#maxBufferedAudioBytes) {
      const dropped = this.#pendingAudio.shift();
      if (!dropped) {
        this.#pendingAudioBytes = 0;
        return;
      }
      this.#pendingAudioBytes -= dropped.byteLength;
    }
  }

  #flushBufferedAudio(replacement: Generation): void {
    if (this.#pendingAudio.length === 0) {
      return;
    }
    const buffered = this.#pendingAudio;
    this.#pendingAudio = [];
    this.#pendingAudioBytes = 0;
    this.#audioReachedCurrent = true;
    for (const chunk of buffered) {
      replacement.session.sendAudio(chunk);
    }
  }

  /**
   * Keeps a superseded session open long enough for its trailing `usage` to
   * arrive. Closing at the switch discards billed tokens with no trace.
   */
  #linger(generation: Generation): void {
    if (generation.dead || this.#lingerMs <= 0) {
      generation.session.close();
      this.#reportLinger(generation);
      return;
    }
    this.#lingering.add(generation);
    generation.lingerTimer = this.#schedule(() => {
      if (!this.#lingering.delete(generation)) {
        return;
      }
      generation.lingerTimer = null;
      generation.session.close();
      this.#reportLinger(generation);
    }, this.#lingerMs);
  }

  #reportLinger(generation: Generation): void {
    this.#emitRotation({
      type: 'linger-ended',
      generation: generation.index,
      lateUsageFacts: this.#lateUsage.get(generation.index) ?? 0,
    });
    this.#lateUsage.delete(generation.index);
  }

  #cancelTimers(): void {
    this.#preArmTimer?.cancel();
    this.#boundaryTimer?.cancel();
    this.#gapTimer?.cancel();
    this.#retryTimer?.cancel();
    this.#callerUtteranceTimer?.cancel();
    this.#preArmTimer = null;
    this.#boundaryTimer = null;
    this.#gapTimer = null;
    this.#retryTimer = null;
    this.#callerUtteranceTimer = null;
  }

  #emitRotation(event: RotationEvent): void {
    logger.info(`[RotatingUpstream] ${event.type}`, { ...event });
    this.#onRotation(event);
  }
}

/** Everything {@link withSessionRotation} may tune, minus what one session supplies. */
export type SessionRotationOptions = Omit<
  RotatingUpstreamOptions,
  'upstream' | 'config' | 'onFact'
>;

/**
 * Presents a provider upstream as one whose sessions rotate, so an orchestrator
 * gets a conversation that outlives the provider's connection cap without knowing
 * that rotation exists.
 *
 * This is the shim shape a session orchestrator expects: the same `id` and the
 * same `capabilities` as the upstream it wraps — rotation changes neither, since
 * both are facts about the provider — and an `open` that hands back a
 * {@link RotatingUpstreamSession} in place of a single connection.
 *
 * A no-op is the correct outcome for a provider whose cap is longer than any
 * session the caller allows: the timing derives from `capabilities.maxSessionMs`,
 * so nothing arms before then and no connection is ever replaced.
 *
 * `connect` MUST open a FRESH transport per call. A closure that hands back one
 * pre-opened socket every time puts the replacement session on the same
 * connection as the session it replaces, which is not a rotation — on a provider
 * that accepts its configuration frame once, it is a dead session.
 */
export function withSessionRotation(
  upstream: RealtimeUpstream,
  options: SessionRotationOptions = {},
): RealtimeUpstream {
  return {
    id: upstream.id,
    capabilities: upstream.capabilities,
    open: (config, onFact) =>
      RotatingUpstreamSession.open({ ...options, upstream, config, onFact }),
  };
}

/**
 * Names the connection a `usage` fact came from, and leaves every other fact
 * untouched.
 *
 * This is the one place that knows, and a biller cannot recover it any other way:
 * a provider reporting session-cumulative totals restarts them per connection, and
 * arrival order does not separate the generations because a superseded session
 * lingers to pay its arrears. Stamped for every generation rather than only for
 * the live one — a pre-opened replacement is billed for its replayed transcript
 * before it is ever switched to, and that spend belongs to the generation that
 * incurred it.
 */
function attributeUsage(generation: number, fact: UpstreamFact): UpstreamFact {
  return fact.type === 'usage' ? { ...fact, generation } : fact;
}

/** How far two conversations agree from the beginning, entry for entry. */
function commonPrefixLength(
  carried: ReadonlyArray<TranscriptEntry>,
  current: ReadonlyArray<TranscriptEntry>,
): number {
  let matched = 0;
  while (matched < carried.length && matched < current.length) {
    if (!sameEntry(carried[matched], current[matched])) {
      return matched;
    }
    matched += 1;
  }
  return matched;
}

/**
 * How much of the end of one conversation is the beginning of another.
 *
 * The two are the same conversation seen at different times, and a transcript
 * trimmed to its budget in between has lost entries from the front — so where a
 * seeded replacement rejoins the conversation as it stands is a suffix of what it
 * carries meeting a prefix of what is current. Zero is a real answer: the trim
 * removed everything the replacement holds, and none of the current conversation
 * has reached it.
 */
function tailOverlapLength(
  carried: ReadonlyArray<TranscriptEntry>,
  current: ReadonlyArray<TranscriptEntry>,
): number {
  for (let length = Math.min(carried.length, current.length); length > 0; length -= 1) {
    if (tailMatchesHead(carried, current, length)) {
      return length;
    }
  }
  return 0;
}

function tailMatchesHead(
  carried: ReadonlyArray<TranscriptEntry>,
  current: ReadonlyArray<TranscriptEntry>,
  length: number,
): boolean {
  const offset = carried.length - length;
  for (let index = 0; index < length; index += 1) {
    if (!sameEntry(carried[offset + index], current[index])) {
      return false;
    }
  }
  return true;
}

function sameEntry(
  before: TranscriptEntry | undefined,
  after: TranscriptEntry | undefined,
): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    before.role === after.role &&
    before.text === after.text
  );
}

function describeFormats(session: { inputFormat: AudioFormat; outputFormat: AudioFormat }): string {
  const input = `${session.inputFormat.encoding}@${session.inputFormat.sampleRateHz}`;
  const output = `${session.outputFormat.encoding}@${session.outputFormat.sampleRateHz}`;
  return `${input} in / ${output} out`;
}
