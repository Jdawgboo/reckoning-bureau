/**
 * AWS Nova Sonic (Bedrock `InvokeModelWithBidirectionalStream`) behind the
 * neutral provider seam.
 *
 * Nova is the third dialect, and the one that shows the seam is a seam rather
 * than a compromise between two providers. It is not "Gemini with different
 * names": its organising abstraction is a **nested container hierarchy** —
 * session → prompt → content blocks, each explicitly opened and closed, with a
 * *single* audio container spanning the entire call — where OpenAI models a
 * mutable conversation of items and Gemini a stream of turns. And it is strictly
 * less expressive than either sibling: nothing is per-response, the client
 * cannot cancel, the conversation cannot be written mid-session, and the
 * connection dies at eight minutes.
 *
 * Four things drive the design, all measured against the live service on
 * 2026-08-14 (`amazon.nova-2-sonic-v1:0`, us-east-1). Where a measurement
 * contradicts AWS's own documentation or the published integrations, the
 * measurement wins and the contradiction is named.
 *
 * 1. **`completionId` is NOT a turn id.** AWS documents a completion as one
 *    model turn, and both Pipecat and LiveKit key their turn state off it. In a
 *    measured session, ONE `completionStart` covered the entire multi-turn
 *    exchange — a refusal, a tool call, and the post-tool answer — and
 *    `completionEnd` fired only after the client sent `promptEnd`, 25 seconds
 *    later. Every one of the 41 `usageEvent`s carried that same `completionId`.
 *    So turn identity is minted locally, as on the OpenAI path, and a turn is
 *    delimited by `contentEnd { type: "AUDIO", stopReason: "END_TURN" }` — never
 *    by `completionEnd`. Both of those are the provider's to send, and neither is
 *    promised, so a turn is bounded locally as well: see
 *    {@link TURN_PROGRESS_DEADLINE_MS}, because a turn that never ends silences
 *    every later utterance including the one carrying the answer.
 *
 * 2. **The assistant's FINAL transcript is not bounded by its turn.** AWS
 *    documents it as arriving after audio but within the completion, which
 *    earlier analysis read as "safe if turn end is `completionEnd`". Measured,
 *    it arrived 2.6 s and then 6.3 s after its audio ended, the second one only
 *    once the *next* input was injected — and the `stopReason` on those blocks
 *    ran `END_TURN` then `PARTIAL_TURN`, so it does not delimit them either.
 *    Late FINAL text is therefore attributed by recency and never starts a turn;
 *    see {@link NovaSonicUpstreamSession} `#onAssistantFinalText`.
 *
 * 3. **Injected text is answered, not obeyed.** This is the sharpest
 *    difference from Gemini, where `realtimeInput.text` is followed as
 *    direction. Nova 2's cross-modal `role: "USER", interactive: true` text is
 *    an ordinary conversational message. Measured, three phrasings in one
 *    session: "Say the word READY and nothing else." → *"Sorry, I can't just say
 *    the word READY without any context or purpose."*; "Say exactly this, word
 *    for word: …" → a refusal about disclosing order details; a bare literal
 *    ("Your refund has been approved.") → a defensive answer about verifying
 *    refunds through official channels. Only a bare conversational trigger
 *    ("hi") produced clean speech. See `speak` for what that means.
 *
 * 4. **8 kHz linear PCM is genuinely native on both legs.** Verified rather
 *    than assumed: `sampleRateHertz: 8000` was accepted on input, echoed back
 *    verbatim in the server's `audioOutputConfiguration`, and the byte count
 *    confirms it — 152,320 bytes for a ~9.5 s utterance is 16,000 B/s, which is
 *    8 kHz 16-bit mono and nothing else. A telephony leg pays no resampling in
 *    either direction, which neither sibling offers.
 *
 * Four further measured facts shape the code and appear nowhere in the docs. A
 * mid-session `SYSTEM` content block is a **fatal** `ValidationException`
 * ("Duplicate SYSTEM content. SYSTEM content can only be provided once per
 * prompt") that kills the stream. Injecting text while the model is still
 * emitting trailing content fires Nova's own barge-in signal — an interruption
 * this adapter caused itself and must not report as the caller speaking. A
 * session that never received caller audio cannot be torn down cleanly at all;
 * see `close`. And **an unfed audio container will not generate**: an injection
 * before any audio has arrived is billed and produces nothing at all, which is why
 * this adapter primes the container with 100 ms of silence at open and refreshes
 * it before every injected turn — measured threshold 68 ms, see
 * {@link PRIMING_SILENCE_MS}. That priming, rather than anything the provider
 * does unaided, is what makes Nova 2 able to greet and relay while the mic is
 * muted.
 */
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
import type { NovaBidirectionalStream } from './nova-bedrock-stream.ts';
import { negotiateAudioFormat } from './util/audio-format.ts';
import { getVoiceLogger } from './util/logger.ts';
import {
  type ScheduleVoiceTimer,
  type VoiceTimerHandle,
  scheduleVoiceTimer,
} from './util/timers.ts';
import { isRecord } from './util/type-guards.ts';

const logger = getVoiceLogger();

export const NOVA_2_SONIC_MODEL = 'amazon.nova-2-sonic-v1:0';

const NOVA_2_SONIC_SPOKEN_LANGUAGES = Object.freeze([
  'English',
  'French',
  'Italian',
  'German',
  'Spanish',
  'Portuguese',
  'Hindi',
]);

function novaSonicSpokenLanguageInstructions(): string {
  return `## Spoken language boundary
- You MUST speak only ${NOVA_2_SONIC_SPOKEN_LANGUAGES.join(', ')}.
- NEVER speak or generate a spoken reply in any other language, even when the user speaks it or asks for it.
- When the user speaks an unsupported language, continue handling their request normally but make every spoken reply in English.
- When the user asks you to speak an unsupported language, reply in English with one brief sentence explaining which languages you can speak.
- This restriction applies only to assistant speech. Preserve the user's original wording and language in tool arguments.
- This boundary overrides any earlier instruction to mirror or switch to the user's language.`;
}

function withNovaSonicSpokenLanguageBoundary(instructions: string): string {
  return `${instructions}\n\n${novaSonicSpokenLanguageInstructions()}`;
}

/**
 * Telephony-native linear PCM. Exported because it is the reason to reach for
 * Nova on a phone leg at all: the PSTN's rate, carried uncompanded, with no
 * resampling at either end.
 */
export const PCM16_8K: AudioFormat = { encoding: 'pcm16', sampleRateHz: 8000 };

const PCM16_16K_LOCAL: AudioFormat = { encoding: 'pcm16', sampleRateHz: 16_000 };

/**
 * Linear PCM at all three documented rates, in each direction, and that is the
 * whole list — there is **no G.711 on Nova in either direction**, so a companded
 * telephony leg must expand to linear (see `util/g711.ts`) even though it does
 * not have to resample.
 *
 * Ordered highest-fidelity first, matching the OpenAI adapter so a caller that
 * states no format gets the same default whichever provider it lands on. A
 * telephony caller should ask for {@link PCM16_8K} explicitly: it is verified
 * working on both legs and costs nothing, but a silent 8 kHz default would
 * quietly muffle every browser session.
 */
const NOVA_AUDIO_FORMATS: readonly AudioFormat[] = Object.freeze([
  PCM16_24K,
  PCM16_16K_LOCAL,
  PCM16_8K,
]);

/**
 * Nova's barge-in signal: a `textOutput` whose entire content is this literal.
 * Matching a magic string is not a shortcut — it is the only report of
 * server-side interruption Nova produces, and AWS's own sample, Pipecat and
 * LiveKit all string-match exactly this.
 */
const BARGE_IN_SIGNAL = '{ "interrupted" : true }';

/**
 * The `stopReason`s that end a model turn, whatever block carries them.
 *
 * The turn delimiter is the stop reason, not the content type. AUDIO is the block
 * that carries it in an ordinary spoken turn, but it is not the only one, and
 * reading only AUDIO left a turn that produced no audio open for the rest of the
 * call — no `model.turn.ended`, and every later `speak` refused.
 *
 * The two reasons deliberately absent are the ones that are *not* endings.
 * `PARTIAL_TURN` means the next sentence of the same utterance is still coming, so
 * honouring it would report a turn per sentence; `TOOL_USE` means the model is
 * waiting for a result and the answer that follows belongs to the same turn.
 */
const TURN_ENDING_STOP_REASONS: ReadonlySet<string> = new Set(['END_TURN', 'INTERRUPTED']);

/**
 * How long a turn that has started may produce nothing at all before it is
 * ended as failed.
 *
 * Every stop reason above arrives from the provider, and a turn Nova never
 * closes is a turn that never ends: `speak` refuses while one is in flight, so a
 * single stranded turn mutes the greeting, the admission, the progress update,
 * the liveness ping and — worst — the relay carrying the answer the caller is
 * waiting for, for the rest of the call. The provider offers no cancel and no
 * timeout of its own, so the bound is this adapter's.
 *
 * The turn holding an outstanding tool call is the one that strands in practice,
 * because `TOOL_USE` is deliberately not a turn ending (see
 * {@link TURN_ENDING_STOP_REASONS}) and nothing obliges the provider to send the
 * ending that should follow the result.
 *
 * 6 s, from the only produce-latency measured on this provider: an injection's
 * first audio byte arrives 573–1343 ms later (median ~920 ms warm, ~1.3 s from a
 * cold stream). This is ~4.5x the slowest of those, and generated audio arrives
 * faster than it plays, so no healthy turn — mid-utterance, between the sentences
 * of one utterance, or thinking before its first byte — comes near it. Erring
 * long is deliberate: cutting a turn that was still speaking makes the listener
 * hear a sentence stop dead, which is worse than the silence this bounds.
 */
export const TURN_PROGRESS_DEADLINE_MS = 6_000;

/**
 * How long an accepted injection may take to produce its first frame before the
 * adapter reports that the speech did not happen.
 *
 * Its own deadline rather than a share of {@link TURN_PROGRESS_DEADLINE_MS},
 * because the two waits fail differently and are worth different margins. An
 * injection Nova swallows produces no content block at all, so no `contentEnd`
 * can carry the stop reason that would end it, and `completionEnd` — the other
 * exit — was measured arriving only after the client sends `promptEnd`, i.e. at
 * teardown. Mid-session there is nothing else to wait for.
 *
 * 4 s: ~3x the slowest measured injection-to-first-audio (1343 ms), ~4.4x the
 * ~920 ms median. Shorter than the started-turn deadline because the cost of
 * cutting early is smaller — nobody is speaking, so the turn is only mislabelled
 * if the provider answers late, where cutting a started turn truncates audio the
 * caller is listening to.
 */
export const INJECTED_SPEECH_DEADLINE_MS = 4_000;

const DEFAULT_VOICE = 'matthew';

/**
 * How far ahead of the hard cap `session.ending` is reported.
 *
 * Nova sends no warning of its own, unlike Gemini's `goAway`, so this is the
 * adapter's estimate and the seam marks it as such. 60 s is the room a rotation
 * needs: AWS's own session-continuation sample waits for the assistant to finish
 * speaking before it swaps, and LiveKit starts recycling at six minutes of the
 * eight.
 */
export const DEFAULT_SESSION_ENDING_LEAD_MS = 60_000;

/**
 * The hard connection cap stated by AWS: "There is a connection limit of 8
 * minutes". Exceeding it surfaces as
 * `ModelTimeoutException`, and there is no resumption handle — recovery is
 * replaying history into a brand new stream.
 */
const NOVA_MAX_SESSION_MS = 480_000;

/** 16-bit linear PCM: the only sample width Nova accepts, in either direction. */
const BYTES_PER_SAMPLE = 2;

/**
 * Silence written into the audio container the moment it opens, so the model will
 * generate before the caller has said anything.
 *
 * Nova will not produce a turn from a container it has never been fed — an
 * injection into an unfed one is billed and answered with nothing — and the
 * threshold was measured by stepping the amount down over 33 live sessions, three
 * repeats around the boundary:
 *
 * | Silence | Result |
 * |---|---|
 * | 0–66 ms | no turn, no text, no audio (66 ms twice, 64 ms three times) |
 * | 68 ms | speaks, three times out of three |
 * | 72 ms – 2 s | speaks |
 *
 * Three properties of that threshold decide the shape of this constant:
 *
 * 1. **It is a DURATION, not a byte count.** 1,920 bytes at 24 kHz (40 ms) stays
 *    silent while 1,088 bytes at 8 kHz (68 ms) speaks, and the boundary lands
 *    between 64 and 72 ms at both rates. So the figure is in milliseconds and the
 *    byte count is derived from whatever rate was negotiated — a telephony leg at
 *    8 kHz needs the same 100 ms as a browser at 24 kHz, and fewer bytes to carry
 *    it.
 * 2. **It need not arrive in real time.** 80 ms delivered as one unpaced write,
 *    with the injection immediately behind it, speaks. That is what makes this
 *    free: priming costs one frame on the wire, not 100 ms of waiting.
 * 3. **Frame shape is irrelevant.** One chunk and four 20 ms chunks behave
 *    identically, so this is a single write.
 *
 * 100 ms rather than the measured 68 ms edge: 68 is the smallest value observed to
 * work, and shipping the edge of a measured boundary means any provider-side
 * change to the window silently restores a silent greeting. 100 ms is 1,600 bytes
 * at 8 kHz and 4,800 at 24 kHz — small enough to be free, far enough clear to
 * absorb a shift.
 *
 * Silence rather than fabricated speech, deliberately: measured, digital silence
 * primes the container without producing `caller.speech.started`, a transcript, or
 * a barge-in signal, so nothing the caller did not say enters the conversation.
 */
const PRIMING_SILENCE_MS = 100;

/**
 * Whether this adapter feeds the container itself, and therefore whether it can
 * speak before the caller does.
 *
 * Derived rather than declared so the two cannot drift: setting
 * {@link PRIMING_SILENCE_MS} to zero flips `canSpeakBeforeFirstInput` back to
 * false, which is what makes `speak` start refusing again instead of billing for
 * silence.
 */
const PRIMES_AUDIO_CONTAINER = PRIMING_SILENCE_MS > 0;

/**
 * The Nova 2 provider contract. Every `false` is a fact checked against the live
 * service, not a member left unimplemented.
 */
const NOVA_SONIC_BASE_CAPABILITIES: Omit<
  RealtimeCapabilities,
  'canSpeakUnprompted' | 'canSpeakBeforeFirstInput'
> = {
  /** The nine client event types open and close containers; none commands a generation. */
  clientDrivenTurns: false,
  /** No cancel event exists. LiveKit's `interrupt()` and `truncate()` are both no-ops for Nova. */
  hardCancel: false,
  /** No `audio_end_ms` anywhere: the client cannot tell Nova how much audio the caller heard. */
  truncateAtPlayback: false,
  /**
   * The system prompt is one content block per prompt. Verified the hard way: a
   * second one is a fatal `ValidationException` that ends the stream.
   */
  perResponseInstructions: false,
  /** `toolChoice` lives in `promptStart`, is session-scoped, and has no `none` value. */
  perResponseToolChoice: false,
  /** Every response joins the conversation; there is no out-of-band form. */
  outOfBandResponses: false,
  /** `toolConfiguration` is part of `promptStart`, which may be sent once. */
  mutableTools: false,
  /** Verified live: a `toolResult` produced a spoken answer with nothing requested. */
  autoRepliesAfterTool: true,
  // `TOOL_USE` is not a turn-ending stop reason: the turn stays open waiting for
  // the result, so a caller that withholds it until the turn ends waits forever.
  expectsToolResultDuringTurn: true,
  /** No speech start/stop is ever reported; what this adapter emits is inferred, and late. */
  emitsSpeechBoundaries: false,
  /**
   * True, and unconditionally so — ASR text arrives whether or not it was asked
   * for, which is why {@link UpstreamSessionConfig.transcription} has nowhere to
   * go on this provider and is reported as ignored rather than dropped.
   */
  canTranscribeCaller: true,
  callerNoiseReduction: false,
  /** No handle, no token, no resume event. Recovery is replaying history into a new stream. */
  sessionResumption: false,
  /**
   * FALSE, against the research position that Nova 2 says "let me look that up"
   * on its own.
   *
   * Measured: with a neutral system prompt, a tool call held for 2.5 s produced
   * no speech whatsoever — nothing between the caller's question and `toolUse`,
   * and nothing while the result was outstanding. Declaring this true would make
   * the orchestrator suppress its own admission narration and leave the caller
   * listening to silence, which is the worse of the two failure modes.
   */
  selfNarratesToolLatency: false,
  /**
   * FALSE, and measured rather than assumed.
   *
   * All three roles were tried mid-session. `SYSTEM` is a fatal
   * `ValidationException`. `USER` is not a write at all — it starts a generation,
   * which is what `speak` uses it for. `ASSISTANT` is accepted with no error and
   * then **silently discarded**: after writing "The caller's name is Marguerite
   * Okonkwo and she ordered a walnut loaf", the model answered "I don't have
   * access to specific customer information like names or past orders."
   *
   * Declaring this true with an `appendContext` that returns null — the shape
   * the Gemini adapter uses — would be worse than useless here, because on
   * Gemini the write actually lands. A write that is accepted and ignored is the
   * exact failure this seam exists to make undeclarable, so the capability is
   * false and the members are absent. Grounding reaches Nova only through
   * {@link UpstreamSessionConfig.history} at open, which is the documented and
   * verified path.
   */
  mutableConversation: false,
  supportedInputFormats: NOVA_AUDIO_FORMATS,
  supportedOutputFormats: NOVA_AUDIO_FORMATS,
  maxSessionMs: NOVA_MAX_SESSION_MS,
};

/** Nova 2 Sonic: injected text produces a turn, so the agent can open the call. */
export const NOVA_2_SONIC_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  ...NOVA_SONIC_BASE_CAPABILITIES,
  canSpeakUnprompted: true,
  /**
   * True **because this adapter primes the audio container at open**, not because
   * the provider can open its own mouth unaided.
   *
   * Nova will not generate from a container it has never been fed: measured on
   * both transports, an injection into an unfed one produced no turn, no text and
   * no audio while still billing the tokens. What makes the flag true is
   * {@link PRIMING_SILENCE_MS} — 100 ms of silence written the moment the
   * container opens, on every session including every rotated one — and the value
   * is derived from that constant so removing the priming flips the declaration
   * back rather than leaving it lying.
   *
   * A reader who deletes the priming should find that out here: without it, the
   * agent's first utterance on an answered call is silence, and the only signal is
   * a caller listening to nothing.
   *
   * What priming does NOT buy is speed. Measured after priming, the injection's
   * first audio byte arrives 573–1343 ms later (median ~920 ms warm, ~1.3 s from a
   * cold stream), so the greeting is prompt-ish rather than immediate. That is a
   * product judgement above this seam, not a reason to declare the capability
   * false.
   */
  canSpeakBeforeFirstInput: PRIMES_AUDIO_CONTAINER,
});

/**
 * Scheduling for the session-ending warning, injectable so tests need not wait
 * seven minutes. Aliases of the library-wide types in `util/timers.ts`, kept
 * under their original names so this adapter's published surface is unchanged.
 */
export type NovaTimerHandle = VoiceTimerHandle;
export type NovaScheduleTimer = ScheduleVoiceTimer;

export interface NovaSonicUpstreamOptions {
  /** Opens one Bedrock bidirectional stream; see `nova-bedrock-stream.ts`. */
  connect(): Promise<NovaBidirectionalStream>;
  /** One of Nova's prebuilt voices; the session config may override it. */
  voice?: string;
  /** `sessionStart.inferenceConfiguration`. Fixed for the session's life. */
  maxTokens?: number;
  topP?: number;
  temperature?: number;
  /** Nova 2 only: how quickly the server decides the caller stopped speaking. */
  endpointingSensitivity?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** How far ahead of the 8-minute cap `session.ending` is reported. */
  sessionEndingLeadMs?: number;
  /** Clock for caller-turn timestamps; injectable so tests are deterministic. */
  now?: () => number;
  /** Timer for the session-ending warning; injectable for the same reason. */
  scheduleTimer?: NovaScheduleTimer;
}

interface SessionDeps {
  stream: NovaBidirectionalStream;
  config: UpstreamSessionConfig;
  onFact: (fact: UpstreamFact) => void;
  capabilities: RealtimeCapabilities;
  voice: string;
  maxTokens: number;
  topP: number;
  temperature: number;
  endpointingSensitivity: 'HIGH' | 'MEDIUM' | 'LOW';
  sessionEndingLeadMs: number;
  inputFormat: AudioFormat;
  outputFormat: AudioFormat;
  now: () => number;
  scheduleTimer: NovaScheduleTimer;
}

/**
 * One model turn. `started` separates a turn `speak` asked for from one Nova
 * actually began, so an injection the model ignored never becomes a turn the
 * orchestrator has to reconcile.
 */
interface ModelTurn {
  id: string;
  reason: SpeechReason | 'unprompted';
  correlationId?: string;
  started: boolean;
  audioDone: boolean;
}

/** One caller utterance, delimited by the ASR content block that carries it. */
interface CallerItem {
  id: string;
  contentId: string;
  text: string;
  startedAt: number;
}

/** What an output content block is, read from its `contentStart`. */
interface OutputContent {
  type: string;
  role: string;
  /** `FINAL` or `SPECULATIVE`, unwrapped from the JSON-inside-JSON `additionalModelFields`. */
  stage: string;
}

export class NovaSonicUpstreamSession implements RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities;
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  #stream: NovaBidirectionalStream;
  #onFact: (fact: UpstreamFact) => void;
  #now: () => number;
  #promptName = crypto.randomUUID();
  #audioContentName = crypto.randomUUID();
  #closed = false;

  #turnCounter = 0;
  #callerCounter = 0;
  #turn: ModelTurn | null = null;
  /** Owner of any late FINAL transcript, since Nova's carries no turn key. */
  #lastEndedTurnId: string | null = null;
  #callerItem: CallerItem | null = null;
  #outputContent = new Map<string, OutputContent>();
  #outstandingToolUseIds = new Set<string>();
  /**
   * An injection is on the wire, so the next barge-in signal is this adapter
   * interrupting Nova's own trailing content rather than the caller speaking.
   */
  #selfInflictedInterrupt = false;
  /** Whether the audio container has ever been fed. Nova refuses to close an empty one. */
  #audioSent = false;
  #endingTimer: NovaTimerHandle | null = null;
  #scheduleTimer: NovaScheduleTimer;
  /**
   * The bound on the turn in flight. At most one exists, because at most one turn
   * does — `#armTurnDeadline` replaces it rather than adding to it, and every path
   * that clears `#turn` cancels it.
   */
  #turnDeadline: NovaTimerHandle | null = null;

  constructor(deps: SessionDeps) {
    this.#stream = deps.stream;
    this.#onFact = deps.onFact;
    this.#now = deps.now;
    this.#scheduleTimer = deps.scheduleTimer;
    this.capabilities = deps.capabilities;
    this.inputFormat = deps.inputFormat;
    this.outputFormat = deps.outputFormat;

    this.#send({ sessionStart: this.#buildSessionStart(deps) });
    this.#send({ promptStart: this.#buildPromptStart(deps) });
    this.#sendTextBlock(
      'SYSTEM',
      false,
      withNovaSonicSpokenLanguageBoundary(deps.config.instructions),
    );
    this.#seedHistory(deps.config.history ?? []);
    this.#openAudioContainer(deps.inputFormat);
    this.#primeAudioContainer(deps.inputFormat);
    this.#reportIgnoredTranscriptionConfig(deps.config);
    void this.#pump();
    this.#endingTimer = this.#scheduleTimer(
      () => {
        this.#emit({ type: 'session.ending', inMs: deps.sessionEndingLeadMs, resumable: false });
      },
      Math.max(0, NOVA_MAX_SESSION_MS - deps.sessionEndingLeadMs),
    );
    // The stream is already open by the time `connect` resolved — Bedrock's
    // handshake completes before the first frame is pulled — so there is no
    // `setupComplete` to wait for and nothing later to report.
    this.#emit({ type: 'session.opened' });
  }

  /**
   * Caller audio into the single container opened at construction. Nova has no
   * append/commit buffer: every frame of the whole call shares one
   * `contentName`, and opening a second audio block per utterance is not how the
   * protocol works.
   */
  sendAudio(audio: Uint8Array): void {
    if (this.#closed) {
      return;
    }
    // Bytes, not calls: an empty frame leaves the container as unfed as it was,
    // for both the teardown Nova rejects and the speech it will not produce.
    this.#audioSent = this.#audioSent || audio.byteLength > 0;
    this.#send({
      audioInput: {
        promptName: this.#promptName,
        contentName: this.#audioContentName,
        content: Buffer.from(audio).toString('base64'),
      },
    });
  }

  sendText(text: string, _callerItemId: string): void {
    if (this.#closed) {
      return;
    }
    this.#selfInflictedInterrupt = false;
    this.#sendTextBlock('USER', true, text);
  }

  /**
   * Makes the agent speak, by the only lever Nova has: a cross-modal
   * `role: "USER", interactive: true` text block.
   *
   * **`text` is a prompt, not a script.** Unlike Gemini — where the same
   * mechanism is obeyed as direction — Nova answers it as a conversational
   * message, and answers it defensively when it reads as an instruction to
   * recite. Three phrasings were measured and all three failed to produce the
   * requested words; only a plain conversational trigger produced clean speech
   * (see the file header). So a caller that needs *specific wording* cannot get
   * it from this provider, and an orchestrator that needs it must synthesize
   * above the seam. What this method reliably delivers is that the agent opens
   * its mouth, in its own voice, on topic.
   *
   * Every reason except `reply` is rendered identically — `greeting`,
   * `admission`, `liveness`, `narration` and `relay` all become the same
   * cross-modal text block, because Nova offers no per-response lever to
   * distinguish them with (`perResponseInstructions` and `perResponseToolChoice`
   * are both false).
   *
   * Four requests are refused, each resolving null rather than throwing:
   *
   * - **Before the container has any audio in it**, where
   *   `canSpeakBeforeFirstInput` is false. Nova will not generate from an unfed
   *   audio container, but it *will* bill the injected tokens, so putting the
   *   request on the wire buys nothing and costs money. This adapter primes the
   *   container at open ({@link PRIMING_SILENCE_MS}), so on Nova 2 the branch is
   *   unreachable and a greeting works from the first moment; it exists so a build
   *   with priming removed refuses instead of paying for silence. Every accepted
   *   injection refreshes the audio container first too: measured live, a second
   *   cross-modal turn after a tool response was swallowed with no fresh mic
   *   frames, and succeeded while the container kept receiving gated silence.
   *   Supplying that frame here makes relays independent of the caller leaving
   *   their microphone unmuted.
   * - `reason: 'reply'`. The server owns the answer to a caller turn
   *   (`clientDrivenTurns: false`); injecting one produces a *second* turn over
   *   the top of the one Nova is already generating.
   * - While a turn is in flight. There is no cancel (`hardCancel: false`), so a
   *   second injection cannot replace the utterance in flight, only talk over
   *   it. Whether to retry is scheduling policy the orchestrator owns. This
   *   refusal is bounded rather than open-ended: a turn that stops producing is
   *   ended on its own deadline (see {@link TURN_PROGRESS_DEADLINE_MS}), so a
   *   turn the provider never closes cannot mute the rest of the call.
   * - With no text. There is no other way to start a generation, so an empty
   *   injection is a silent no-op dressed as a turn.
   *
   * `fidelity` changes nothing: injection speaks in the model's own voice, so
   * `model-voice-required` is satisfied whenever the request is honoured at all,
   * and choosing a different voice is a decision above this seam.
   */
  async speak(request: SpeakRequest): Promise<string | null> {
    if (this.#closed) {
      return null;
    }
    if (!this.capabilities.canSpeakBeforeFirstInput && !this.#audioSent) {
      // Unreachable while the container is primed at open, which is exactly the
      // point: both halves read the same constant, so a build with priming
      // switched off declares the capability false AND starts refusing here,
      // rather than injecting into an unfed container and paying for silence.
      logger.warn('[NovaSonicUpstream] refused speech before the caller has been heard', {
        reason: request.reason,
        correlationId: request.correlationId,
        expected: 'Nova Sonic does not generate from an audio container it was never fed',
      });
      return null;
    }
    if (request.reason === 'reply') {
      logger.info('[NovaSonicUpstream] refused a reply: the server owns caller turns', {
        correlationId: request.correlationId,
      });
      return null;
    }
    if (this.#turn) {
      logger.info('[NovaSonicUpstream] refused speech: a turn is already in flight', {
        reason: request.reason,
        activeTurnId: this.#turn.id,
      });
      return null;
    }
    if (!request.text) {
      logger.warn('[NovaSonicUpstream] refused speech with no text to inject', {
        reason: request.reason,
      });
      return null;
    }
    const turn = this.#startTurn(request.reason);
    if (request.correlationId) {
      turn.correlationId = request.correlationId;
    }
    this.#selfInflictedInterrupt = true;
    this.#primeAudioContainer(this.inputFormat);
    this.#sendTextBlock('USER', true, request.text);
    return turn.id;
  }

  /**
   * Returns a tool result as an ordinary TOOL content block — Nova has no
   * dedicated result event. No reply is requested and none can be:
   * `autoRepliesAfterTool` is true, verified live.
   *
   * A result for an unknown `toolUseId` is dropped rather than sent, because Nova
   * rejects it with a `ValidationException` that kills the whole stream. Dropping
   * it is still the lesser failure — a dead connection ends the call — but it is
   * NOT a recoverable one: AWS warns a missing result makes the model "enter a
   * waiting state, causing unresponsive behavior", and nothing this adapter can
   * send makes it answer. So the drop is reported as a fault naming the turn, and
   * the turn is ended as `failed`. A log line would leave that decision to
   * nobody, and an open turn slot would leave the orchestrator unable to act on
   * it: `speak` refuses while a turn is in flight, so the session that reported
   * the wedge would then be unable to say a word about it for the rest of the
   * call.
   */
  submitToolResult(callId: string, output: string): void {
    if (this.#closed) {
      return;
    }
    if (!this.#outstandingToolUseIds.delete(callId)) {
      this.#reportUndeliverableToolResult(callId);
      return;
    }
    const contentName = crypto.randomUUID();
    this.#send({
      contentStart: {
        promptName: this.#promptName,
        contentName,
        interactive: false,
        type: 'TOOL',
        role: 'TOOL',
        toolResultInputConfiguration: {
          toolUseId: callId,
          type: 'TEXT',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    this.#send({
      toolResult: { promptName: this.#promptName, contentName, content: novaToolContent(output) },
    });
    this.#send({ contentEnd: { promptName: this.#promptName, contentName } });
  }

  /**
   * Says out loud that a tool result went nowhere, and abandons the turn it went
   * nowhere in. `turnId` is carried where a turn is open, because that is the
   * turn the model is stuck in and the one an orchestrator would have to abandon.
   */
  #reportUndeliverableToolResult(callId: string): void {
    logger.warn('[NovaSonicUpstream] tool result for an unknown tool use id', { callId });
    const turnId = this.#turn?.id;
    const message = `no outstanding Nova Sonic tool use with id ${callId}; the model is left waiting and this adapter cannot make it answer`;
    this.#emit(
      turnId
        ? { type: 'fault', code: 'tool_result_undeliverable', message, recoverable: true, turnId }
        : { type: 'fault', code: 'tool_result_undeliverable', message, recoverable: true },
    );
    this.#abandonWedgedTurn();
  }

  /**
   * Gives up on a turn the model will never finish, so the seam's promise that a
   * started turn ends is kept even here. `failed` rather than `interrupted`,
   * because nobody spoke over it — reading a provider wedge as a barge-in would
   * have the orchestrator conclude the caller took the floor on a silent line.
   *
   * Only a turn that started: an unstarted one is an injection still in flight,
   * which this failure has nothing to do with, and ending it would report speech
   * as lost that is still on its way.
   */
  #abandonWedgedTurn(): void {
    const turn = this.#turn;
    if (!turn?.started) {
      return;
    }
    this.#detachTurn();
    this.#lastEndedTurnId = turn.id;
    this.#emitTurnEnded(turn, 'failed');
  }

  /**
   * Lets go of the turn in flight: the slot `speak` checks, the suppression flag
   * that belongs to it, and its deadline.
   *
   * Every path that ends a turn goes through here, which is what makes "no turn
   * in flight" and "no deadline armed" the same state rather than two states that
   * have to be kept in step. It hands nothing back: each caller already holds the
   * turn, because each reports a different terminal for it.
   */
  #detachTurn(): void {
    this.#turn = null;
    this.#selfInflictedInterrupt = false;
    this.#turnDeadline?.cancel();
    this.#turnDeadline = null;
  }

  /**
   * Ends the turn in flight before the fact that the session is over goes out —
   * the model-side counterpart of the caller-side finalization every teardown
   * path already does. Without it a stream that dies mid-utterance leaves the
   * orchestrator holding a turn that never ends: masked while a closed session
   * is also a finished call, and fatal the moment something above this adapter
   * reconnects and carries that turn into the next stream.
   *
   * Unlike the wedged-turn case above, this also ends a turn that never
   * started: an injection still in flight has no stream left to be spoken on,
   * so the same "the requested speech did not happen" fault an ordinary turn
   * end reports is the truthful report here, and leaving the turn open would
   * strand the request that asked for it forever.
   *
   * `failed` rather than `interrupted`: nobody spoke over this turn, and an
   * orchestrator that reads a dead stream as a barge-in concludes the caller
   * took the floor on a line that has already gone silent.
   *
   * Idempotent: the turn is detached as it ends, so the stream failure that
   * follows a close finds nothing left to end.
   */
  #endTurnOnTeardown(): void {
    const turn = this.#turn;
    if (!turn) {
      return;
    }
    this.#detachTurn();
    if (!turn.started) {
      this.#emit({
        type: 'fault',
        code: 'speech_not_produced',
        message: `the connection ended before the injected ${turn.reason} was spoken`,
        recoverable: true,
        turnId: turn.id,
      });
      return;
    }
    this.#lastEndedTurnId = turn.id;
    this.#emitTurnEnded(turn, 'failed');
  }

  /**
   * Closes the containers in the order Nova requires — audio, then prompt, then
   * session. Skipping any of them leaves the conversation incomplete and the
   * server-side resources orphaned.
   *
   * A container that never received a byte **has no clean teardown**, and both
   * ways out were measured: closing the empty container is `ValidationException:
   * Cannot end content [id] as no content data was received`, and leaving it open
   * is `All contents must be closed before ending prompt`. So the protocol order
   * is followed and the rejection is expected; because `#closed` is already set,
   * the failing stream reports nothing, and the caller still sees one clean
   * `session.closed`.
   *
   * The priming at open (see {@link PRIMING_SILENCE_MS}) means that no longer
   * happens: every container holds at least 100 ms before it is closed, so the
   * warning below is now the sign of a build with priming removed rather than of an
   * ordinary short session. Note the priming was NOT adopted to fix this — it
   * exists so the agent can speak first — and it is silence rather than fabricated
   * speech precisely because measurement showed silence produces no
   * `caller.speech.started`, no transcript and no barge-in, so nothing the caller
   * did not say enters the conversation.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cancelTimers();
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    if (!this.#audioSent) {
      logger.warn('[NovaSonicUpstream] closing a session that never received caller audio', {
        promptName: this.#promptName,
        expected: 'Nova rejects the teardown of an audio container it was never fed',
      });
    }
    this.#send({
      contentEnd: { promptName: this.#promptName, contentName: this.#audioContentName },
    });
    this.#send({ promptEnd: { promptName: this.#promptName } });
    this.#send({ sessionEnd: {} });
    this.#stream.close();
    this.#emit({ type: 'session.closed', reason: 'local' });
  }

  #buildSessionStart(deps: SessionDeps): Record<string, unknown> {
    const sessionStart: Record<string, unknown> = {
      inferenceConfiguration: {
        maxTokens: deps.maxTokens,
        topP: deps.topP,
        temperature: deps.temperature,
      },
    };
    sessionStart.turnDetectionConfiguration = {
      endpointingSensitivity: deps.endpointingSensitivity,
    };
    return sessionStart;
  }

  /**
   * The one configuration frame. Voice, output format, modalities and the whole
   * tool list are bound here for the session's life — which is why
   * `mutableTools`, `perResponseInstructions` and `perResponseToolChoice` are
   * all false.
   */
  #buildPromptStart(deps: SessionDeps): Record<string, unknown> {
    const promptStart: Record<string, unknown> = {
      promptName: this.#promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        mediaType: 'audio/lpcm',
        sampleRateHertz: deps.outputFormat.sampleRateHz,
        sampleSizeBits: 16,
        channelCount: 1,
        voiceId: deps.voice,
        encoding: 'base64',
        audioType: 'SPEECH',
      },
    };
    if (deps.config.tools.length > 0) {
      promptStart.toolUseOutputConfiguration = { mediaType: 'application/json' };
      promptStart.toolConfiguration = { tools: deps.config.tools.map(toNovaToolSpec) };
    }
    return promptStart;
  }

  /**
   * Prior conversation, one content block per message, after the system prompt
   * and before audio streaming begins — the only window Nova accepts it in.
   *
   * A leading assistant message is dropped: AWS requires the first history entry
   * to be from the user, and a session that violates it is rejected rather than
   * degraded. LiveKit strips the same thing for the same reason.
   */
  #seedHistory(history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>): void {
    let entries = history;
    const firstUser = entries.findIndex((entry) => entry.role === 'user');
    if (entries.length > 0 && firstUser !== 0) {
      logger.warn('[NovaSonicUpstream] dropping leading assistant history', {
        reason: 'Nova rejects a session whose history does not begin with the user',
        dropped: firstUser === -1 ? entries.length : firstUser,
      });
      entries = firstUser === -1 ? [] : entries.slice(firstUser);
    }
    for (const entry of entries) {
      this.#sendTextBlock(entry.role === 'assistant' ? 'ASSISTANT' : 'USER', false, entry.text);
    }
  }

  /**
   * Opens the single audio container the whole call shares. Done at
   * construction, not on first `sendAudio`, because a prompt with no audio
   * content block is rejected at `promptEnd` with "must have at least one audio
   * content" — a failure that would otherwise appear only at hangup.
   */
  #openAudioContainer(inputFormat: AudioFormat): void {
    this.#send({
      contentStart: {
        promptName: this.#promptName,
        contentName: this.#audioContentName,
        type: 'AUDIO',
        interactive: true,
        role: 'USER',
        audioInputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: inputFormat.sampleRateHz,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: 'SPEECH',
          encoding: 'base64',
        },
      },
    });
  }

  /**
   * Feeds the container when it opens and before cross-modal speech.
   *
   * One write, unpaced: the threshold is a duration of *samples*, not elapsed wall
   * time, so 100 ms of silence handed over in a single frame primes the model
   * immediately rather than 100 ms from now. The same refresh before `speak`
   * keeps a muted caller's delayed relay independent of browser audio. See
   * {@link PRIMING_SILENCE_MS} for the measurements behind both the amount and
   * the margin over the 68 ms boundary.
   *
   * Routed through `sendAudio` rather than writing its own frame, so there is one
   * definition of "the container has bytes" — which is also what stops `close`
   * hitting the teardown Nova rejects for an unfed container.
   */
  #primeAudioContainer(inputFormat: AudioFormat): void {
    if (!PRIMES_AUDIO_CONTAINER) {
      return;
    }
    const bytes = Math.round(
      (PRIMING_SILENCE_MS * inputFormat.sampleRateHz * BYTES_PER_SAMPLE) / 1000,
    );
    this.sendAudio(new Uint8Array(bytes));
  }

  /**
   * Nova transcribes the caller unconditionally and exposes no knob for it —
   * no transcriber model, no language, and no steering prompt. A surface that
   * set them would otherwise wonder why they had no effect.
   */
  #reportIgnoredTranscriptionConfig(config: UpstreamSessionConfig): void {
    const ignored = Object.keys(config.transcription ?? {});
    if (ignored.length > 0) {
      logger.warn('[NovaSonicUpstream] caller-transcription steering is not configurable', {
        ignored,
      });
    }
  }

  /** Drains the response stream. Completion is a hangup; a throw is a failure. */
  async #pump(): Promise<void> {
    try {
      for await (const frame of this.#stream.events()) {
        if (this.#closed) {
          return;
        }
        this.#handleFrame(frame);
      }
      this.#handleStreamEnded();
    } catch (error) {
      this.#handleStreamFailed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleFrame(frame: Record<string, unknown>): void {
    const event = isRecord(frame.event) ? frame.event : null;
    if (!event) {
      return;
    }
    if (isRecord(event.contentStart)) {
      this.#onContentStart(event.contentStart);
    }
    if (isRecord(event.textOutput)) {
      this.#onTextOutput(event.textOutput);
    }
    if (isRecord(event.audioOutput)) {
      this.#onAudioOutput(event.audioOutput);
    }
    if (isRecord(event.toolUse)) {
      this.#onToolUse(event.toolUse);
    }
    if (isRecord(event.contentEnd)) {
      this.#onContentEnd(event.contentEnd);
    }
    if (isRecord(event.completionEnd)) {
      this.#onCompletionEnd(event.completionEnd);
    }
    if (isRecord(event.usageEvent)) {
      this.#onUsageEvent(event.usageEvent);
    }
  }

  /**
   * Records what a content block is, and opens the turn or caller item it
   * belongs to.
   *
   * A FINAL assistant block deliberately does NOT open a turn: it is the
   * trailing transcript of a turn that already ended, and treating it as the
   * start of one is precisely the phantom turn that took the Gemini path out of
   * production.
   */
  #onContentStart(body: Record<string, unknown>): void {
    const contentId = stringField(body, 'contentId');
    const content: OutputContent = {
      type: stringField(body, 'type'),
      role: stringField(body, 'role'),
      stage: generationStageOf(body),
    };
    this.#outputContent.set(contentId, content);
    if (content.type === 'TEXT' && content.role === 'USER') {
      this.#openCallerItem(contentId);
      return;
    }
    if (content.type === 'TOOL' || content.type === 'AUDIO') {
      this.#ensureTurn();
      return;
    }
    if (content.type === 'TEXT' && content.stage === 'SPECULATIVE') {
      this.#ensureTurn();
    }
  }

  #onTextOutput(body: Record<string, unknown>): void {
    const text = stringField(body, 'content');
    if (text.includes(BARGE_IN_SIGNAL)) {
      this.#onBargeIn();
      return;
    }
    const content = this.#outputContent.get(stringField(body, 'contentId'));
    if (!content || !text) {
      return;
    }
    if (content.role === 'USER') {
      this.#onCallerTranscript(stringField(body, 'contentId'), text);
      return;
    }
    if (content.stage === 'FINAL') {
      this.#onAssistantFinalText(text);
      return;
    }
    const turn = this.#ensureTurn();
    this.#emit({ type: 'model.text', text, turnId: turn.id, final: false });
  }

  /**
   * The transcript of what was actually spoken, which is the only thing that
   * differs from the speculative text after a barge-in — and therefore worth
   * reporting even though it arrives late.
   *
   * Attribution is by recency and nothing better is available: measured, these
   * blocks arrive 2.6–9 s after their audio ended, they carry no turn key of any
   * kind, and the common case is that they arrive only once the NEXT input is
   * sent — so a turn is usually already open by then, and it is not theirs.
   * Preferring that open turn files every transcript one turn late; measured over
   * a three-exchange session, it did so every single time.
   *
   * So an open turn only claims one once it has produced something of its own.
   * Until then the turn that most recently ended is the better answer, because
   * ordering is the one property these blocks do have. A block arriving before
   * any turn has ended is dropped rather than attributed to nothing.
   *
   * `confidence: 'proposed'` is therefore not decoration — every branch is the
   * adapter guessing, and an orchestrator that treats this as a keyed fact will
   * eventually file one turn's words under another's.
   */
  #onAssistantFinalText(text: string): void {
    const turnId = this.#attributeFinalText();
    if (!turnId) {
      logger.warn('[NovaSonicUpstream] final transcript with no turn to attribute it to', { text });
      return;
    }
    this.#emit({ type: 'model.text', text, turnId, final: true, confidence: 'proposed' });
  }

  /** Owner of a late FINAL transcript, per the attribution rule above. */
  #attributeFinalText(): string | null {
    const open = this.#turn;
    if (open?.started) {
      return open.id;
    }
    return this.#lastEndedTurnId ?? open?.id ?? null;
  }

  #onAudioOutput(body: Record<string, unknown>): void {
    const turn = this.#ensureTurn();
    // Byte-for-byte in the negotiated output format; the seam's `model.audio`
    // carries whatever `open` settled on, not necessarily linear PCM.
    this.#emit({
      type: 'model.audio',
      audio: Buffer.from(stringField(body, 'content'), 'base64'),
      turnId: turn.id,
    });
  }

  /**
   * Reported on `toolUse` rather than on the `contentEnd` that follows it, which
   * is where AWS's sample and both integrations fire. The event is
   * self-contained — name, id and arguments all arrive together — so waiting for
   * the block to close buys nothing and costs a round of latency on a call where
   * the caller is already waiting.
   */
  #onToolUse(body: Record<string, unknown>): void {
    const turn = this.#ensureTurn();
    const callId = stringField(body, 'toolUseId');
    const name = stringField(body, 'toolName');
    if (!callId || !name) {
      logger.warn('[NovaSonicUpstream] tool use with no id or name', { callId, name });
      return;
    }
    this.#outstandingToolUseIds.add(callId);
    this.#emit({
      type: 'tool.called',
      turnId: turn.id,
      callId,
      name,
      args: parseToolArguments(stringField(body, 'content'), name),
    });
  }

  /**
   * Closes whatever the block was, and ends the turn when the block's
   * `stopReason` says the turn is over — see {@link TURN_ENDING_STOP_REASONS} for
   * why the reason decides rather than the content type.
   *
   * A FINAL-stage assistant TEXT block is the one exception, and it delimits
   * nothing at all. Measured, those arrive 2.6–9 s after the audio they describe
   * and their `stopReason` ran `END_TURN` then `PARTIAL_TURN` (file header, note
   * 2), so honouring it would close whichever turn happened to be open when the
   * *previous* turn's transcript landed.
   */
  #onContentEnd(body: Record<string, unknown>): void {
    const contentId = stringField(body, 'contentId');
    const content = this.#outputContent.get(contentId);
    this.#outputContent.delete(contentId);
    if (!content) {
      return;
    }
    if (content.type === 'TEXT' && content.role === 'USER') {
      this.#finalizeCallerItem();
      return;
    }
    if (content.type === 'TEXT' && content.stage === 'FINAL') {
      return;
    }
    const stopReason = stringField(body, 'stopReason');
    if (!TURN_ENDING_STOP_REASONS.has(stopReason)) {
      return;
    }
    this.#emitAudioDone();
    this.#endTurn(stopReason === 'INTERRUPTED' ? 'interrupted' : 'completed');
  }

  /**
   * A safety net, not the turn delimiter. Measured, one completion spanned an
   * entire multi-turn exchange and `completionEnd` arrived only after
   * `promptEnd` — so by the time it fires there is normally nothing open, and
   * when there is, the turn ended without its audio ever closing.
   */
  #onCompletionEnd(body: Record<string, unknown>): void {
    if (!this.#turn) {
      return;
    }
    this.#emitAudioDone();
    this.#endTurn(stringField(body, 'stopReason') === 'INTERRUPTED' ? 'interrupted' : 'completed');
  }

  /**
   * Passed through verbatim: which token buckets are billable is the billing
   * layer's model.
   *
   * One thing that layer must know, because it inverts against Gemini:
   * `details.total` is **cumulative for the whole session**, not per turn.
   * Measured across 41 events in one session, `total.output.speechTokens` rose
   * monotonically 416 → 436 → 456 → 460 while every event carried the same
   * `completionId`. Summing them would multiply the bill; the last `total` is
   * the answer, and `details.delta` is what to sum if events were missed.
   */
  #onUsageEvent(body: Record<string, unknown>): void {
    this.#emit({ type: 'usage', turnId: this.#turn?.id ?? null, raw: body });
  }

  /**
   * Nova stopped speaking because it heard something over the top of itself.
   *
   * Except when this adapter caused it: injecting text while trailing content is
   * still arriving fires the same signal, verified in every measured session.
   * That case is not a barge-in in any sense and nothing about it is reported —
   * not the caller speaking, and not the end of a turn.
   *
   * Ending the turn there was the sharper half of the bug. `speak` refuses while
   * a turn is in flight, so a self-inflicted signal always finds the turn the
   * injection *just* opened and has not started yet: ending it emitted
   * `speech_not_produced` for speech that was still coming, made the real speech
   * arrive as a fresh `unprompted` turn stripped of its reason and correlation
   * id, and — because the turn slot was free again — let a second `speak` through
   * on top of the generation already pending.
   */
  #onBargeIn(): void {
    if (this.#selfInflictedInterrupt) {
      this.#selfInflictedInterrupt = false;
      logger.info('[NovaSonicUpstream] interruption caused by our own injection, not the caller', {
        turnId: this.#turn?.id,
      });
      return;
    }
    this.#emit({ type: 'caller.speech.started', confidence: 'proposed' });
    this.#emitAudioDone();
    this.#endTurn('interrupted');
  }

  /**
   * Opens the caller's utterance. Inferred and marked as such: Nova reports no
   * speech boundary at all, and this fires only once ASR has already produced
   * text, so it is late relative to the caller actually opening their mouth.
   */
  #openCallerItem(contentId: string): CallerItem {
    const existing = this.#callerItem;
    if (existing?.contentId === contentId) {
      return existing;
    }
    if (existing) {
      this.#finalizeCallerItem();
    }
    this.#discardSupersededSpeech();
    this.#callerCounter += 1;
    const item: CallerItem = {
      id: `caller_${this.#callerCounter}`,
      contentId,
      text: '',
      startedAt: this.#now(),
    };
    this.#callerItem = item;
    this.#emit({ type: 'caller.speech.started', confidence: 'proposed' });
    return item;
  }

  #onCallerTranscript(contentId: string, text: string): void {
    const item = this.#openCallerItem(contentId);
    item.text += text;
    this.#emit({
      type: 'caller.transcript',
      text,
      final: false,
      turnStartedAt: item.startedAt,
      callerItemId: item.id,
    });
  }

  /**
   * The ASR block closing is the one real terminal Nova gives, so unlike Gemini
   * the commit is a reported boundary rather than something derived from the
   * model happening to produce content.
   */
  #finalizeCallerItem(): void {
    const item = this.#callerItem;
    if (!item) {
      return;
    }
    this.#callerItem = null;
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
    this.#emit({ type: 'caller.speech.stopped', confidence: 'proposed' });
    this.#emit({ type: 'caller.turn.committed', callerItemId: item.id });
  }

  /**
   * The caller took the floor before injected speech was produced. That speech
   * is gone: the turn Nova is about to take answers the caller, and adopting the
   * pending request for it would report the caller's reply under the greeting's
   * reason and correlation id.
   */
  #discardSupersededSpeech(): void {
    const turn = this.#turn;
    if (!turn || turn.started) {
      return;
    }
    this.#detachTurn();
    this.#emit({
      type: 'fault',
      code: 'speech_superseded',
      message: `the caller began speaking before the injected ${turn.reason} was spoken`,
      recoverable: true,
      turnId: turn.id,
    });
  }

  /**
   * The turn incoming content belongs to. A turn `speak` requested is adopted
   * here rather than at request time, so an injection Nova ignored never becomes
   * a turn that started; everything else is a turn the server decided to take.
   */
  #ensureTurn(): ModelTurn {
    const turn = this.#turn ?? this.#startTurn('unprompted');
    if (!turn.started) {
      turn.started = true;
      this.#selfInflictedInterrupt = false;
      this.#emitTurnStarted(turn);
    }
    // Every frame that belongs to this turn arrives through here, and nothing
    // else does — see `#armTurnDeadline` for why that is the whole refresh rule.
    this.#armTurnDeadline();
    return turn;
  }

  #startTurn(reason: SpeechReason | 'unprompted'): ModelTurn {
    this.#turnCounter += 1;
    const turn: ModelTurn = {
      id: `turn_${this.#turnCounter}`,
      reason,
      started: false,
      audioDone: false,
    };
    this.#turn = turn;
    this.#armTurnDeadline();
    return turn;
  }

  /**
   * Puts a bound on the turn in flight, replacing whatever bound it had.
   *
   * **What refreshes it is the point.** Every call site is either a turn being
   * created or `#ensureTurn`, and `#ensureTurn` is reached from exactly the four
   * frames that are this turn producing something: the `contentStart` that opens
   * one of its blocks, its speculative text, its audio, and its tool use. Nothing
   * else touches the deadline — not the caller's ASR blocks (a caller asking
   * "what are you doing?" into a stranded turn must not extend it, which is the
   * shape the live failure took), not `usageEvent`s (dozens per session, on a
   * timer of the provider's own), and not the assistant's late FINAL transcript,
   * which is measured arriving seconds after its audio and is attributed by
   * recency rather than owned by the open turn.
   *
   * The delay depends on whether the turn started, because the two waits are
   * different: {@link INJECTED_SPEECH_DEADLINE_MS} bounds an injection waiting to
   * be answered, {@link TURN_PROGRESS_DEADLINE_MS} bounds a turn that answered
   * and then went quiet.
   */
  #armTurnDeadline(): void {
    const turn = this.#turn;
    this.#turnDeadline?.cancel();
    this.#turnDeadline = null;
    // `#closed` as well as the turn, so nothing can be armed after a teardown and
    // report a fact once the session has already been declared closed.
    if (!turn || this.#closed) {
      return;
    }
    this.#turnDeadline = this.#scheduleTimer(
      () => this.#onTurnDeadline(turn),
      turn.started ? TURN_PROGRESS_DEADLINE_MS : INJECTED_SPEECH_DEADLINE_MS,
    );
  }

  /**
   * The turn produced nothing for its whole deadline, so it is over — reported in
   * the same words the provider's own endings are, because the orchestrator's
   * problem is identical either way: the turn slot has to be free and the request
   * that asked for the speech has to be told how it went.
   *
   * `failed`, never `interrupted`: nobody spoke over this turn, and an
   * orchestrator that reads a stall as a barge-in concludes the caller took the
   * floor on a line that has gone silent.
   *
   * `turn` is carried rather than re-read so a timer that somehow outlives its
   * turn cannot end a later one — the identity check below is the whole guard.
   */
  #onTurnDeadline(turn: ModelTurn): void {
    this.#turnDeadline = null;
    if (this.#closed || this.#turn !== turn) {
      return;
    }
    logger.warn('[NovaSonicUpstream] ending a turn that stopped producing', {
      turnId: turn.id,
      reason: turn.reason,
      started: turn.started,
      afterMs: turn.started ? TURN_PROGRESS_DEADLINE_MS : INJECTED_SPEECH_DEADLINE_MS,
    });
    if (!turn.started) {
      this.#detachTurn();
      this.#emit({
        type: 'fault',
        code: 'speech_not_produced',
        message: `Nova Sonic produced nothing for the injected ${turn.reason} within ${INJECTED_SPEECH_DEADLINE_MS} ms`,
        recoverable: true,
        turnId: turn.id,
      });
      return;
    }
    // Before the end, as on every provider-driven ending: a transport holding
    // audio for this turn finalizes playback on it and would otherwise wait for
    // a terminal that is not coming either.
    this.#emitAudioDone();
    this.#detachTurn();
    this.#lastEndedTurnId = turn.id;
    this.#emitTurnEnded(turn, 'failed');
  }

  /**
   * Every timer this session owns, cancelled together on every way out.
   *
   * One call rather than a pair of cancels per teardown path, because this
   * library runs many concurrent calls in one process: a timer left behind on one
   * of the three exits is a leak per call, and the exit that forgets is the one
   * nobody tests.
   */
  #cancelTimers(): void {
    this.#endingTimer?.cancel();
    this.#endingTimer = null;
    this.#turnDeadline?.cancel();
    this.#turnDeadline = null;
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
   * A turn that never started produced nothing, so a fault says so rather than
   * leaving the orchestrator waiting on a `model.turn.started` that is not
   * coming.
   *
   * The suppression flag is disarmed here as well as in `#ensureTurn`, because a
   * turn can end without ever starting — an injection Nova swallowed, closed out
   * by `completionEnd`. Leaving it armed would spend the suppression on the
   * caller's next genuine barge-in instead.
   */
  #endTurn(outcome: 'completed' | 'interrupted'): void {
    const turn = this.#turn;
    if (!turn) {
      return;
    }
    this.#detachTurn();
    if (!turn.started) {
      this.#emit({
        type: 'fault',
        code: 'speech_not_produced',
        message: `Nova Sonic ended the turn without speaking the injected ${turn.reason}`,
        recoverable: true,
        turnId: turn.id,
      });
      return;
    }
    this.#lastEndedTurnId = turn.id;
    this.#emitTurnEnded(turn, outcome);
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
        ? { type: 'model.turn.ended', turnId: turn.id, outcome, correlationId: turn.correlationId }
        : { type: 'model.turn.ended', turnId: turn.id, outcome },
    );
  }

  /** The stream finished with nothing left to say — Nova's equivalent of a hangup. */
  #handleStreamEnded(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cancelTimers();
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    this.#emit({ type: 'session.closed', reason: 'remote' });
  }

  /**
   * A stream failure. Terminal and reported as such: Nova states its rejections
   * by throwing on the response iterator — a `ValidationException` for a
   * malformed frame, `ModelTimeoutException` at the eight-minute cap — and the
   * stream is gone in every case, so there is nothing recoverable about it.
   */
  #handleStreamFailed(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cancelTimers();
    this.#finalizeCallerItem();
    this.#endTurnOnTeardown();
    this.#emit({
      type: 'fault',
      code: error.name || 'stream_error',
      message: error.message,
      recoverable: false,
    });
    this.#emit({ type: 'session.closed', reason: 'error' });
  }

  /** Sends one client frame in Nova's wire shape. */
  #send(event: Record<string, unknown>): void {
    this.#stream.send({ event });
  }

  /** The three-part text pattern Nova requires for every text content block. */
  #sendTextBlock(role: string, interactive: boolean, content: string): void {
    const contentName = crypto.randomUUID();
    this.#send({
      contentStart: {
        promptName: this.#promptName,
        contentName,
        type: 'TEXT',
        interactive,
        role,
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    });
    this.#send({ textInput: { promptName: this.#promptName, contentName, content } });
    this.#send({ contentEnd: { promptName: this.#promptName, contentName } });
  }

  #emit(fact: UpstreamFact): void {
    this.#onFact(fact);
  }
}

/** Opens Nova Sonic sessions. One instance per configured transport. */
export class NovaSonicUpstream implements RealtimeUpstream {
  readonly id = 'nova-sonic';
  readonly capabilities = NOVA_2_SONIC_CAPABILITIES;

  #options: NovaSonicUpstreamOptions;

  constructor(options: NovaSonicUpstreamOptions) {
    this.#options = options;
  }

  async open(
    config: UpstreamSessionConfig,
    onFact: (fact: UpstreamFact) => void,
  ): Promise<NovaSonicUpstreamSession> {
    if (config.resumptionHandle) {
      // Opening fresh would leave a caller that believes it resumed with no
      // history and no way to notice.
      throw new Error(
        'Nova Sonic has no session resumption; open a fresh session and replay history',
      );
    }
    const inputFormat = negotiateAudioFormat({
      provider: 'Nova Sonic',
      direction: 'input',
      requested: config.inputFormat,
      supported: this.capabilities.supportedInputFormats,
    });
    const outputFormat = negotiateAudioFormat({
      provider: 'Nova Sonic',
      direction: 'output',
      requested: config.outputFormat,
      supported: this.capabilities.supportedOutputFormats,
    });
    const stream = await this.#options.connect();
    return new NovaSonicUpstreamSession({
      stream,
      config,
      onFact,
      capabilities: this.capabilities,
      voice: config.voice ?? this.#options.voice ?? DEFAULT_VOICE,
      maxTokens: this.#options.maxTokens ?? 2048,
      topP: this.#options.topP ?? 0.9,
      temperature: this.#options.temperature ?? 0.7,
      endpointingSensitivity: this.#options.endpointingSensitivity ?? 'MEDIUM',
      sessionEndingLeadMs: this.#options.sessionEndingLeadMs ?? DEFAULT_SESSION_ENDING_LEAD_MS,
      inputFormat,
      outputFormat,
      now: this.#options.now ?? Date.now,
      scheduleTimer: this.#options.scheduleTimer ?? scheduleVoiceTimer,
    });
  }
}

/** Nova takes the parameter schema as a JSON *string*, not as an object. */
/**
 * A tool result as Nova will accept it: a JSON document, always.
 *
 * The seam hands `submitToolResult` an opaque string, and in practice every
 * result this orchestrator produces is a sentence for the model to act on —
 * "Forwarded.", "Stopped. Confirm in a few words." Nova parses this field rather
 * than reading it as text, so a bare sentence is rejected with
 * `ValidationException: Tool Response parsing error`, which is not recoverable
 * and takes the session with it.
 *
 * Wrapping rather than testing whether the string already looks like JSON: the
 * argument is opaque by contract, so sniffing it would make the wire shape
 * depend on the punctuation a tool happened to return. This is the same shape
 * the Gemini adapter sends for the same value.
 */
function novaToolContent(output: string): string {
  return JSON.stringify({ output });
}

function toNovaToolSpec(tool: UpstreamToolDefinition): Record<string, unknown> {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: JSON.stringify(tool.parameters) },
    },
  };
}

/**
 * `additionalModelFields` is a JSON string nested inside a JSON field, so the
 * generation stage needs unwrapping twice. AWS's own sample does the same.
 */
function generationStageOf(body: Record<string, unknown>): string {
  const raw = body.additionalModelFields;
  if (typeof raw !== 'string') {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.generationStage === 'string') {
      return parsed.generationStage;
    }
  } catch {
    logger.warn('[NovaSonicUpstream] unparseable additionalModelFields', { raw });
  }
  return '';
}

/** Unparseable arguments become an empty record: the call happened, its shape is unknown. */
function parseToolArguments(content: string, name: string): Record<string, unknown> {
  if (!content) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    logger.warn('[NovaSonicUpstream] unparseable tool arguments', { name });
  }
  return {};
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}
