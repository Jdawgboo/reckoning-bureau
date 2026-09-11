/**
 * The neutral live-provider seam.
 *
 * Today OpenAI Realtime's *wire protocol* is this library's internal lingua
 * franca and other providers are translated into it. That works for one
 * provider and fails for the rest, because the differences are semantic, not
 * lexical: OpenAI's client creates a response and can cancel it, Gemini's
 * server decides when to speak and cannot be stopped, Nova Sonic's server
 * decides and offers nothing per-response at all.
 *
 * A translator has no way to say "this provider cannot do that", so it must
 * invent something plausible instead — which is how an emulated `response.done`
 * comes to retarget a binding the manager no longer holds.
 *
 * This seam removes the need to invent. An upstream declares what it can do
 * (`RealtimeCapabilities`), the orchestrator branches on the declaration, and
 * a capability that is absent is absent rather than faked.
 *
 * Two design rules earn their keep:
 *
 * 1. **The intersection is the interface.** Only verbs every provider can
 *    honour are mandatory. Everything else is capability-gated, because a verb
 *    two of three providers must no-op is not a contract.
 *
 * 2. **Except `speak`, which is mandatory anyway.** An agent that cannot open
 *    its mouth is not a voice agent, and on an answered phone call silence
 *    reads as a dead line. Where a provider offers no way to speak unprompted,
 *    the adapter is required to produce speech by other means rather than
 *    decline. See `speak` for the contract.
 */

/**
 * What an upstream can actually do. Every field is a fact about the provider,
 * not a preference — adapters declare, orchestrators branch, nothing negotiates.
 *
 * The provider columns in each comment are the measured position as of
 * 2026-08-14 and exist so a future reader can tell a deliberate `false` from an
 * unimplemented one.
 */
export interface RealtimeCapabilities {
  /**
   * The client can ask for a reply at a moment of its choosing.
   * OpenAI: yes (`response.create`). Gemini: no — server VAD owns turn onset.
   * Nova Sonic: no — the server decides unilaterally.
   */
  clientDrivenTurns: boolean;

  /**
   * In-flight generation can be stopped by the client.
   * OpenAI: yes (`response.cancel`). Gemini: no. Nova Sonic: no.
   *
   * Note this is about stopping the *model*, not stopping playback — a
   * transport that owns its own audio sink can always stop the caller hearing
   * more. What a provider without this loses is context truncation: it believes
   * it said the whole utterance while the listener heard three words.
   */
  hardCancel: boolean;

  /**
   * The model's record of what it said can be trimmed to what was actually
   * heard, so its context matches the listener's.
   * OpenAI: yes (`conversation.item.truncate`). Gemini: no. Nova Sonic: no.
   */
  truncateAtPlayback: boolean;

  /**
   * Instructions can be set for a single response without mutating the session.
   * OpenAI: yes. Gemini: no — direction has to enter as ordinary conversation
   * text. Nova Sonic: no.
   */
  perResponseInstructions: boolean;

  /**
   * Tools can be suppressed for a single response.
   * OpenAI: yes (`tool_choice: 'none'`). Gemini: no — `toolConfig` is absent
   * from the Live surface entirely, and per `googleapis/python-genai` issue
   * #468 (closed 2026-06-12) that is a backend gap, so bypassing the SDK does
   * not help either. Nova Sonic: no.
   */
  perResponseToolChoice: boolean;

  /**
   * A response can be generated without joining the conversation history.
   * OpenAI: yes (`conversation: 'none'`). Gemini: no. Nova Sonic: no.
   */
  outOfBandResponses: boolean;

  /** The advertised tool list can change without reconnecting. OpenAI: yes; others: no. */
  mutableTools: boolean;

  /**
   * After a tool result the model replies on its own.
   * OpenAI: no — the orchestrator must ask. Gemini and Nova Sonic: yes.
   *
   * This one inverts, which is why it is a capability rather than an
   * assumption: driving a reply on a provider that already replied produces two.
   */
  autoRepliesAfterTool: boolean;

  /**
   * A tool call leaves the turn open, and the result is expected inside it.
   * OpenAI and Gemini Live: no — the call ends the turn and the result follows it.
   * Nova Sonic: yes.
   *
   * The difference is not a detail of bookkeeping. An orchestrator that runs a
   * turn's tool calls when the turn *retires* deadlocks against a provider that
   * will not end the turn until it has the result: each is waiting for the other,
   * and the call goes silent until something unrelated breaks the tie. Where this
   * is true the result has to be produced during the turn, so the calls must run
   * when they arrive rather than when the turn is done.
   *
   * "Ends the turn" is the question, and it is not the same as
   * {@link autoRepliesAfterTool} — that one asks whether the *result* produces
   * speech. A provider can answer yes to both, and Nova Sonic does.
   */
  expectsToolResultDuringTurn: boolean;

  /** Explicit caller speech start/stop signals are emitted. */
  emitsSpeechBoundaries: boolean;

  /**
   * The provider CAN transcribe caller audio — a trait, not a promise.
   *
   * Named for the capability rather than the effect because, unlike every other
   * flag here, transcripts only arrive when `UpstreamSessionConfig.transcription`
   * is also supplied. An orchestrator that reads this as "transcripts will
   * arrive" and omits the config gets silence with no error.
   */
  canTranscribeCaller: boolean;
  /**
   * The provider can be told where the caller's microphone is, and filters for
   * it. A laptop microphone at arm's length and a telephone leg are different
   * acoustic problems, and a provider tuned for the first hears a call as
   * noise it should suppress.
   *
   * OpenAI: yes (`noise_reduction`). Gemini: no. Nova Sonic: no.
   */
  callerNoiseReduction: boolean;

  /**
   * A dropped connection can be resumed with provider-side state intact.
   * Gemini: yes on Vertex (transparent mode). OpenAI and Nova Sonic: no —
   * recovery means replaying history into a fresh session.
   */
  sessionResumption: boolean;

  /**
   * The model narrates its own tool latency ("let me look that up") unprompted.
   *
   * The speech this governs is `admission` (see {@link SpeechReason}): the
   * utterance that tells the caller their request was taken while the work
   * behind it runs. Declaring this true means the provider covers that silence
   * itself and the orchestrator must not also speak, or the caller hears both.
   *
   * No provider measured so far does this. Nova Sonic 2 was reported to and
   * does not: a tool call held 2.5s under a neutral system prompt produced
   * silence, not filler. The flag stays because the failure is asymmetric —
   * declaring it true suppresses the orchestrator's own admission speech and
   * leaves the caller listening to nothing.
   */
  selfNarratesToolLatency: boolean;

  /**
   * The provider can be made to speak without a caller turn preceding it.
   *
   * False does NOT excuse an adapter from implementing `speak` — it tells the
   * orchestrator, before a session is ever opened, that every `speak` will
   * refuse.
   *
   * That is what a configuration-time check WOULD read to reject an
   * incompatible provider-and-channel pairing when someone sets it, rather than
   * leaving it to be discovered by a caller listening to silence on an answered
   * phone line. **No such check exists yet** — as of 2026-08-17 this flag and
   * `canSpeakBeforeFirstInput` are read only by the adapters that declare them.
   * What is built is the narrower runtime refusal: an unservable model id is
   * rejected at session open with close 4004 naming it. That catches a wrong
   * id, not a valid id paired with a channel it cannot serve.
   *
   * This remains a provider-neutral contract even when every currently
   * supported adapter reports true; a future adapter must declare false rather
   * than accept and bill speech requests it cannot honour.
   */
  canSpeakUnprompted: boolean;

  /**
   * The provider can speak on a session that has received **no caller audio at
   * all** — the agent opening its own mouth first, before it has heard anything.
   *
   * Distinct from {@link canSpeakUnprompted}: false there means every `speak`
   * refuses for the whole session; false here means only requests before the
   * caller's first audio do, while mid-session speech works normally.
   *
   * The distinction is the greeting, and the greeting is the one that matters:
   * on an answered phone call the agent's first utterance is the whole point,
   * and it is the one utterance guaranteed to arrive before any caller audio.
   *
   * Nova Sonic is the case this exists for. Measured on both paths
   * (runtime-through-relay and builder-direct, identically), a `speak` into a
   * session whose audio content container has never been fed produces no turn,
   * no text and no audio — only real `usageEvent` frames, so it bills for
   * nothing.
   *
   * An adapter may **earn** a true declaration rather than inherit it: the Nova 2
   * adapter primes its own container with a measured amount of silence at open, so
   * it declares true and a greeting works from the first moment. That is the
   * honest reading of this flag — "speech before the caller's first input works on
   * this upstream" — and an adapter doing it must say in its own comments that the
   * priming is the reason, because deleting the priming silently un-declares the
   * capability.
   *
   * The condition is per connection, not per call: a rotation opens a replacement
   * whose container is empty again. An adapter that primes must therefore prime
   * every session it opens, and one declaring false must refuse the first `speak`
   * of every generation until audio has flowed to that generation (see
   * `RotatingUpstreamSession`).
   *
   * Note what it does not promise: that the speech is *prompt*. Nova's primed
   * injection still takes ~0.6–1.3 s to produce its first audio byte, which is a
   * latency budget the layer above owns.
   */
  canSpeakBeforeFirstInput: boolean;

  /**
   * The conversation can be written mid-session, not only seeded at open.
   *
   * OpenAI: yes (`conversation.item.create`, with `delete` for eviction).
   * Gemini: yes for writes — system-role content is honoured on Vertex — but
   * there is no eviction, so grounding accumulates for the life of the
   * connection. Nova Sonic: no, and measurably so — mid-session `SYSTEM`
   * content is a fatal `ValidationException`, `USER` starts a generation
   * rather than writing, and `ASSISTANT` is accepted and then silently
   * discarded (the model subsequently denies knowing what was written).
   *
   * Gated because the orchestrator's grounding ledger depends on it: system
   * context, delivered-result items, and the spoken-greeting write-back that
   * stops the model greeting a visitor twice.
   */
  mutableConversation: boolean;

  /**
   * Audio formats the upstream can accept and emit, most preferred first.
   *
   * Encoding and rate travel together because they are not independent: on
   * OpenAI, 8 kHz is not a rate you select for linear PCM, it is what you get
   * by choosing G.711 — and G.711 has two companding laws. µ-law is the
   * standard in North America and Japan, A-law across most of Europe, so an
   * adapter that hardcodes one transcodes every call in the other half of the
   * world. Naming the format lets a telephony leg that already holds companded
   * audio pass it through untouched rather than expand and re-compand it.
   */
  supportedInputFormats: readonly AudioFormat[];
  supportedOutputFormats: readonly AudioFormat[];

  /**
   * Upper bound on a single connection, or null when the provider states none.
   * Every provider studied caps below the length of an unremarkable phone call,
   * so rotation is the orchestrator's job in all cases; this only says when.
   */
  maxSessionMs: number | null;
}

/**
 * One audio wire format. `g711-ulaw` and `g711-alaw` are 8 kHz by definition;
 * the rate is carried anyway so a single comparison settles compatibility.
 */
export interface AudioFormat {
  encoding: 'pcm16' | 'g711-ulaw' | 'g711-alaw';
  sampleRateHz: number;
}

/** Whether two negotiated formats are the same wire shape. */
export function sameAudioFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRateHz === b.sampleRateHz;
}

/**
 * Canonical formats. G.711's rate is definitional — 8 kHz, both laws — so
 * these exist to stop callers hand-constructing a pairing the wire cannot
 * carry. The interface stays flat rather than a discriminated union because
 * every comparison site treats the two fields uniformly; these constants buy
 * the same safety at the construction sites, which is where it is lost.
 */
export const PCM16_24K: AudioFormat = { encoding: 'pcm16', sampleRateHz: 24000 };
export const G711_ULAW: AudioFormat = { encoding: 'g711-ulaw', sampleRateHz: 8000 };
export const G711_ALAW: AudioFormat = { encoding: 'g711-alaw', sampleRateHz: 8000 };

/**
 * Why the agent is speaking. Drives instruction selection and suppression rules.
 *
 * - `greeting` — the opener on a fresh session.
 * - `admission` — "got it, working on that": the utterance that tells the caller
 *   their request was taken, spoken while the work behind it runs. This is the
 *   reason {@link RealtimeCapabilities.selfNarratesToolLatency} governs, and the
 *   one an orchestrator must not fire on a provider that covers the gap itself.
 * - `progress` — an update carrying a confirmed fact about work still running
 *   ("found twelve sources so far"). It differs from `liveness` in having
 *   something to say and from `admission` in being about the work rather than
 *   the request. What reaches this seam is a produced fact: an adapter is told
 *   what to convey and never learns what made it worth saying, so ordinary tool
 *   lifecycle cannot arrive here by accident.
 * - `liveness` — a keepalive during long work ("still working on it"). It says
 *   nothing new by construction, so it is the class most safely dropped when a
 *   provider is already filling the silence or the line is otherwise busy.
 * - `narration` — the older, undifferentiated progress update. Retained because
 *   today's orchestrator still schedules it, and superseded by `progress`;
 *   `admission` and `liveness` are the other two halves it splits into.
 * - `relay` — delivering a result the work produced.
 * - `reply` — answering a caller turn. The only reason a provider that owns turn
 *   onset (`clientDrivenTurns: false`) refuses, because its server already
 *   replies and a second request produces two overlapping answers.
 *
 * An adapter needs no per-reason behaviour beyond `reply`: every other reason is
 * out-of-band speech with tools suppressed where the provider allows it, and is
 * rendered identically. Each adapter's `speak` states that explicitly.
 */
export const SPEECH_REASONS = [
  'greeting',
  'admission',
  'progress',
  'liveness',
  'narration',
  'relay',
  'reply',
] as const;

export type SpeechReason = (typeof SPEECH_REASONS)[number];

/**
 * A request for the agent to speak.
 *
 * `text` is what should be conveyed, not necessarily what is uttered: where the
 * provider can be steered per response, the adapter passes it as direction and
 * lets the model author the wording. Where it cannot, the adapter may have to
 * speak the text more literally — or, in the last resort, synthesize it.
 */
export interface SpeakRequest {
  reason: SpeechReason;
  /** Direction for the model, or literal copy when nothing else is possible. */
  text: string;
  /**
   * Whether a degraded rendering is acceptable when the provider cannot produce
   * this speech itself.
   *
   * `model-voice-required` means the utterance must come from the model or not
   * at all — the caller would rather have silence than a voice change.
   * `any-voice` permits the adapter to fall back to synthesis, accepting that
   * the listener hears a different voice for this utterance.
   */
  fidelity: 'model-voice-required' | 'any-voice';
  /** Correlates the resulting turn back to the work that requested it. */
  correlationId?: string;
}

/** Tool the upstream may call. Provider-neutral; adapters convert to their own schema dialect. */
export interface UpstreamToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Everything an upstream needs to open a session. */
export interface UpstreamSessionConfig {
  instructions: string;
  tools: UpstreamToolDefinition[];
  voice?: string;
  /** Prior conversation to seed, oldest first. Empty for a fresh conversation. */
  history?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * Resume a prior session instead of starting fresh, using a handle the
   * adapter previously returned from `resumptionHandle()`. Requires
   * `sessionResumption`; adapters without it MUST reject a config carrying one
   * rather than silently opening a fresh session, because a caller that thinks
   * it resumed will not re-seed history and the conversation loses its past.
   *
   * Without this, `sessionResumption` is only half a capability: an adapter can
   * hand out handles and never be given one back.
   */
  resumptionHandle?: string;
  /**
   * Requested wire formats. Each must appear in the adapter's corresponding
   * `supported*Formats`; `open` rejects a mismatch rather than silently
   * converting, so an unsupported pairing is a startup error and not a quality
   * mystery discovered on a call. Omitted means the adapter's first supported
   * format.
   */
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  /**
   * Caller-transcription policy. Lives here rather than inside an adapter
   * because which model transcribes the caller — and in which language — is a
   * product decision that differs per surface, not a provider trait.
   */
  /**
   * Where the caller's microphone sits. Requires `callerNoiseReduction`;
   * adapters without it ignore the field, because the alternative — refusing
   * the session — would deny a call a provider can still carry.
   */
  callerAudio?: { noiseReduction: 'near_field' | 'far_field' };
  transcription?: {
    model?: string;
    language?: string;
    /**
     * Steering text for the transcriber.
     *
     * Load-bearing, not decorative: a strong accent can be decoded as a
     * different language altogether, and this is what tells the transcriber not
     * to. Note that it is separable from `language` — protecting the accent does
     * not require pinning the tongue, and a surface that wants a caller followed
     * into their own language sets this and omits that. A surface that omits
     * both inherits the accent failure, so adapters must pass this through
     * rather than substitute a default of their own.
     */
    prompt?: string;
  };
}

/**
 * Facts an upstream reports. Deliberately *facts*, not commands: nothing here
 * instructs the orchestrator, so an adapter can never drive it into a state the
 * provider did not actually reach.
 */
export type UpstreamFact =
  | { type: 'session.opened' }
  /**
   * The provider believes the caller started or stopped speaking.
   *
   * `confidence: 'proposed'` means the provider is guessing or the adapter
   * inferred it — the orchestrator may override with its own detection. Only
   * `'reported'` comes from a provider that genuinely signals boundaries.
   * Borrowed from Pipecat, and the reason its fabrication across all providers
   * is ~30 lines rather than ~1,000: "I don't know" is representable.
   */
  | { type: 'caller.speech.started'; confidence: 'reported' | 'proposed' }
  | { type: 'caller.speech.stopped'; confidence: 'reported' | 'proposed' }
  /**
   * The caller's utterance is committed to the conversation.
   *
   * Distinct from `caller.speech.stopped` on purpose: VAD believing speech
   * ended and the utterance actually entering the conversation are different
   * facts, and an orchestrator that drives a reply off the former can answer
   * before the provider has the input. OpenAI reports both; adapters that
   * cannot distinguish them should emit only this one.
   */
  | { type: 'caller.turn.committed'; callerItemId?: string }
  /**
   * `callerItemId` keys the utterance this transcript belongs to. Without it,
   * two caller items in flight make a late transcript unattributable — the same
   * conflation this seam removed on the model side, and the cause of a
   * fabricated phantom turn on the Gemini path.
   */
  | {
      type: 'caller.transcript';
      text: string;
      final: boolean;
      turnStartedAt: number;
      callerItemId?: string;
    }
  /** Bytes in the negotiated output format — not necessarily linear PCM. */
  | { type: 'model.audio'; audio: Uint8Array; turnId: string }
  /** No further audio for this turn. Transports finalize playback on it. */
  | { type: 'model.audio.done'; turnId: string }
  /**
   * `confidence: 'proposed'` marks a turn attribution the adapter inferred
   * rather than read. Nova Sonic is why: its final transcript carries no turn
   * key and arrives seconds after the audio it describes, so the adapter can
   * only attribute by recency. Marking that is the difference between an
   * orchestrator knowing it holds a guess and believing it holds a fact.
   */
  | {
      type: 'model.text';
      text: string;
      turnId: string;
      final: boolean;
      confidence?: 'reported' | 'proposed';
    }
  | {
      type: 'model.turn.started';
      turnId: string;
      reason: SpeechReason | 'unprompted';
      /** Echoed from the `SpeakRequest` that opened this turn, when there was one. */
      correlationId?: string;
    }
  /**
   * `failed` is separate from `interrupted` because conflating them makes an
   * orchestrator read a provider error as a barge-in and conclude the listener
   * spoke when they did not.
   */
  | {
      type: 'model.turn.ended';
      turnId: string;
      outcome: 'completed' | 'interrupted' | 'failed';
      correlationId?: string;
    }
  | {
      type: 'tool.called';
      turnId: string;
      callId: string;
      name: string;
      args: Record<string, unknown>;
    }
  /**
   * Provider-shaped usage, passed through verbatim — bucketing is the billing
   * layer's model.
   *
   * `generation` names the connection the figures belong to, counting from 1. An
   * adapter never sets it: one adapter session is one connection, so it has
   * nothing to distinguish. `RotatingUpstreamSession` does, because it presents
   * several connections as one session and a provider reporting
   * session-CUMULATIVE totals (Nova Sonic) restarts those totals per connection —
   * a biller holding one running-total meter for the whole session therefore
   * bills generation 2 nothing until it climbs past generation 1. It cannot be
   * inferred from arrival order either: a superseded session lingers ~20 s to
   * catch late arrears, so generation `n`'s usage keeps arriving after
   * generation `n+1` is live.
   *
   * Absent means "one connection, or an unrotated one" — a biller with a single
   * meter is then already correct.
   */
  | { type: 'usage'; turnId: string | null; raw: Record<string, unknown>; generation?: number }
  /**
   * The connection will end. `inMs` is the provider's own warning where it
   * gives one (Gemini's `goAway` leads by ~60s), else the adapter's estimate.
   */
  | { type: 'session.ending'; inMs: number | null; resumable: boolean }
  /** The connection has ended. Past tense — `session.ending` is the warning. */
  | { type: 'session.closed'; reason: 'local' | 'remote' | 'error' }
  /**
   * The provider confirmed a `truncate`: its conversation now ends where the
   * listener stopped hearing. Requires `truncateAtPlayback`. A refused trim
   * arrives as a `fault` with code `truncate_failed` naming the turn instead —
   * and the difference matters, because a model whose context keeps a sentence
   * nobody heard will refer back to it.
   */
  | { type: 'context.truncated'; turnId: string }
  /**
   * `turnId` and `contextId` name the subject a fault belongs to where one is
   * known — a rejected turn request is attributable, and an orchestrator that
   * wants to requeue that exact intent, or swallow its own context-eviction
   * race, cannot do either from an anonymous error. The alternative is parsing
   * the provider's human-readable message, which is what today's code does.
   */
  | {
      type: 'fault';
      code: string;
      message: string;
      recoverable: boolean;
      turnId?: string;
      contextId?: string;
    };

/**
 * One live session with one provider.
 *
 * Mandatory members are the intersection every provider can honour — plus
 * `speak`, which is mandatory by product requirement rather than by protocol.
 * Optional members correspond one-to-one with a capability flag: an adapter
 * that declares the capability MUST implement the member, and an orchestrator
 * MUST NOT call it without checking.
 */
export interface RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities;

  /**
   * The formats actually negotiated at `open`, after defaults were applied.
   *
   * Observable rather than inferred because under pass-through a caller that
   * guesses wrong produces no error anywhere — just noise on the call, found by
   * a human listening. Re-deriving this from `supportedInputFormats[0]` is the
   * kind of duplicated assumption that drifts.
   */
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  /** Caller audio, in the format negotiated at `open` (`UpstreamSessionConfig.inputFormat`). */
  sendAudio(audio: Uint8Array): void;

  /**
   * Commit one caller-authored text turn through the same provider conversation.
   * Used by deterministic voice scenarios to bypass speech recognition without
   * creating a second orchestration path. The caller supplies the stable local
   * item id; adapters preserve it where their protocol permits.
   */
  sendText(text: string, callerItemId: string): void;

  /**
   * Make the agent say something. Resolves the id of the turn it opened, or
   * null when the request was refused.
   *
   * It returns the turn id rather than a boolean because the orchestrator has
   * to correlate the resulting `model.turn.started` / `model.turn.ended` back
   * to the work that asked for the speech — a relay that cannot tell whether
   * its own utterance completed or was cut short cannot report the outcome of
   * the operation it was narrating.
   *
   * Mandatory. An adapter whose provider cannot speak unprompted must still
   * honour this — by injecting text where that is the only lever, or by
   * synthesizing audio when `fidelity` is `any-voice`. It may refuse only when
   * `fidelity` is `model-voice-required` and the model genuinely cannot be
   * driven, and must then resolve null rather than throw, so the caller can
   * choose silence knowingly instead of discovering it.
   *
   * A refusal must be a refusal, not an attempt. Where a declared capability
   * says the request cannot be honoured — {@link
   * RealtimeCapabilities.canSpeakUnprompted} false, or {@link
   * RealtimeCapabilities.canSpeakBeforeFirstInput} false with no caller audio yet
   * — the adapter resolves null WITHOUT putting the request on the wire, because
   * a provider that swallows an injection still bills the tokens it produced
   * nothing for.
   */
  speak(request: SpeakRequest): Promise<string | null>;

  /** Return a tool result. Whether a reply follows is `autoRepliesAfterTool`. */
  submitToolResult(callId: string, output: string): void;

  close(): void;

  /** Requires `hardCancel`. */
  cancel?(turnId: string): void;

  /**
   * Write a item into the live conversation, returning an id usable with
   * `removeContext`, or null when the provider accepted the write but offers
   * no handle for it. Requires `mutableConversation`.
   *
   * `system` is for grounding an adapter may have to render as another role —
   * Gemini rejects a system role mid-session — which is why the return is
   * nullable rather than a guarantee.
   */
  appendContext?(role: 'system' | 'assistant' | 'user', text: string): string | null;

  /** Requires `mutableConversation`, and only for ids `appendContext` returned. */
  removeContext?(id: string): void;

  /** Requires `truncateAtPlayback`. `playedMs` is what the listener actually heard. */
  truncate?(turnId: string, playedMs: number): void;

  /** Requires `mutableTools`. */
  setTools?(tools: UpstreamToolDefinition[]): void;

  /**
   * Requires `sessionResumption`. Returns an opaque handle the adapter can
   * reopen with, or null when the provider has not issued one yet.
   */
  resumptionHandle?(): string | null;
}

/** Opens sessions for one provider. */
export interface RealtimeUpstream {
  readonly id: string;
  readonly capabilities: RealtimeCapabilities;
  open(
    config: UpstreamSessionConfig,
    onFact: (fact: UpstreamFact) => void,
  ): Promise<RealtimeUpstreamSession>;
}

/**
 * Narrow a session to one that supports a capability, so calling the
 * corresponding optional member is checked rather than asserted.
 */
export function supports<K extends keyof RealtimeCapabilities>(
  session: RealtimeUpstreamSession,
  capability: K,
): boolean {
  return session.capabilities[capability] === true;
}
