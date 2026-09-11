/**
 * In-process fake of a whole provider — a {@link RealtimeUpstream} and the
 * sessions it opens (same philosophy as `ScriptedRealtimePeer` and
 * `ScriptedNovaStream`, one level up: those fake a wire, this fakes an adapter).
 *
 * It exists to make rotation assertable on *observable effects*: which config
 * each generation was opened with, which audio bytes each session received,
 * which session a tool result reached. A double that only counted calls would
 * pass while the caller heard two voices.
 *
 * Two provider behaviours are scriptable because rotation is sensitive to both:
 *
 * - **When `session.opened` arrives.** Nova emits it synchronously from its
 *   constructor, before `open()` has resolved; OpenAI and Gemini emit it later,
 *   from a server frame. A rotator that only listens after `open()` resolves
 *   loses the readiness signal on Nova and waits for its deadline every time.
 * - **Per-generation turn ids.** Every adapter numbers turns from a per-session
 *   counter, so generation 2's first turn is `turn_1` again. This double does the
 *   same, deliberately, so a transcript that merges the two is caught.
 */

import type {
  AudioFormat,
  RealtimeCapabilities,
  RealtimeUpstream,
  RealtimeUpstreamSession,
  SpeakRequest,
  UpstreamFact,
  UpstreamSessionConfig,
  UpstreamToolDefinition,
} from '../realtime-upstream.ts';
import { PCM16_24K } from '../realtime-upstream.ts';

/** How one `open` call should behave. Consumed in order; opens past the end use defaults. */
export interface ScriptedOpenPlan {
  /** Reject the open with this message instead of returning a session. */
  fail?: string;
  /**
   * Hold the open until the test releases it. A real open is a dial, so anything
   * that happens to the live session while a replacement is still connecting —
   * the cap arriving, the line dying — has to be survivable.
   */
  gate?: Promise<void>;
  /** Emit `session.opened` synchronously from `open`, the way Nova does. Default true. */
  announceOpen?: boolean;
  /** Negotiate a different format, to exercise the mismatch guard. */
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
}

export class ScriptedUpstreamSession implements RealtimeUpstreamSession {
  readonly capabilities: RealtimeCapabilities;
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  /** The config this generation was opened with, exactly as the rotator built it. */
  readonly config: UpstreamSessionConfig;
  readonly generation: number;

  readonly audio: Uint8Array[] = [];
  readonly text: Array<{ text: string; callerItemId: string }> = [];
  readonly speakRequests: SpeakRequest[] = [];
  readonly toolResults: Array<{ callId: string; output: string }> = [];
  readonly contextWrites: Array<{ role: string; text: string }> = [];
  readonly contextRemovals: string[] = [];
  readonly toolUpdates: UpstreamToolDefinition[][] = [];
  readonly cancelled: string[] = [];
  readonly truncated: Array<{ turnId: string; playedMs: number }> = [];
  closed = false;
  /** Make `speak` refuse, the way Nova does while a turn is in flight. */
  refuseSpeech = false;
  /**
   * Hold `speak` open until the test releases it, so a rotation can be made to
   * complete inside the await. A real `speak` is a round trip, so anything the
   * rotator records after it must survive the session having been replaced.
   */
  speakGate: Promise<void> | null = null;

  #onFact: (fact: UpstreamFact) => void;
  #turnCounter = 0;
  #contextCounter = 0;
  #handle: string | null = null;
  #issueContextHandles: boolean;

  constructor(params: {
    capabilities: RealtimeCapabilities;
    config: UpstreamSessionConfig;
    onFact: (fact: UpstreamFact) => void;
    inputFormat: AudioFormat;
    outputFormat: AudioFormat;
    generation: number;
    issueContextHandles: boolean;
  }) {
    this.capabilities = params.capabilities;
    this.config = params.config;
    this.#onFact = params.onFact;
    this.inputFormat = params.inputFormat;
    this.outputFormat = params.outputFormat;
    this.generation = params.generation;
    this.#issueContextHandles = params.issueContextHandles;
  }

  sendAudio(audio: Uint8Array): void {
    this.audio.push(audio);
  }

  sendText(text: string, callerItemId: string): void {
    this.text.push({ text, callerItemId });
    this.emit({ type: 'caller.turn.committed', callerItemId });
  }

  async speak(request: SpeakRequest): Promise<string | null> {
    this.speakRequests.push(request);
    if (this.speakGate) {
      await this.speakGate;
    }
    if (this.refuseSpeech) {
      return null;
    }
    return this.nextTurnId();
  }

  submitToolResult(callId: string, output: string): void {
    this.toolResults.push({ callId, output });
  }

  close(): void {
    this.closed = true;
  }

  cancel(turnId: string): void {
    this.cancelled.push(turnId);
  }

  truncate(turnId: string, playedMs: number): void {
    this.truncated.push({ turnId, playedMs });
  }

  appendContext(role: 'system' | 'assistant' | 'user', text: string): string | null {
    this.contextWrites.push({ role, text });
    if (!this.#issueContextHandles) {
      return null;
    }
    this.#contextCounter += 1;
    return `g${this.generation}_ctx${this.#contextCounter}`;
  }

  removeContext(id: string): void {
    this.contextRemovals.push(id);
  }

  setTools(tools: UpstreamToolDefinition[]): void {
    this.toolUpdates.push([...tools]);
  }

  resumptionHandle(): string | null {
    return this.#handle;
  }

  /** Script the provider having issued a resumption handle. */
  issueResumptionHandle(handle: string): void {
    this.#handle = handle;
  }

  /** Per-session numbering, so ids collide across generations exactly as real adapters' do. */
  nextTurnId(): string {
    this.#turnCounter += 1;
    return `turn_${this.#turnCounter}`;
  }

  emit(fact: UpstreamFact): void {
    this.#onFact(fact);
  }

  /** Announce readiness, for the plan that does not do it synchronously. */
  announceOpen(): void {
    this.emit({ type: 'session.opened' });
  }

  /** A complete model turn: started, one line of speech, ended. */
  speakTurn(text: string, turnId = this.nextTurnId()): string {
    this.emit({ type: 'model.turn.started', turnId, reason: 'reply' });
    this.emit({ type: 'model.text', text, turnId, final: true });
    this.emit({ type: 'model.turn.ended', turnId, outcome: 'completed' });
    return turnId;
  }

  /** A turn that starts and stays open, so the rotator sees the model speaking. */
  beginTurn(turnId = this.nextTurnId()): string {
    this.emit({ type: 'model.turn.started', turnId, reason: 'reply' });
    return turnId;
  }

  endTurn(turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): void {
    this.emit({ type: 'model.turn.ended', turnId, outcome });
  }

  /** A caller utterance that reached the conversation. */
  callerSaid(text: string, callerItemId = `item_${this.audio.length}_${text.length}`): void {
    this.emit({
      type: 'caller.transcript',
      text,
      final: true,
      turnStartedAt: 0,
      callerItemId,
    });
    this.emit({ type: 'caller.turn.committed', callerItemId });
  }
}

export class ScriptedUpstream implements RealtimeUpstream {
  readonly id: string;
  readonly capabilities: RealtimeCapabilities;
  readonly sessions: ScriptedUpstreamSession[] = [];
  /** Every config passed to `open`, in order, including ones that then failed. */
  readonly openConfigs: UpstreamSessionConfig[] = [];

  #plans: ScriptedOpenPlan[] = [];
  #inputFormat: AudioFormat;
  #outputFormat: AudioFormat;
  #issueContextHandles: boolean;

  constructor(params: {
    capabilities: RealtimeCapabilities;
    id?: string;
    inputFormat?: AudioFormat;
    outputFormat?: AudioFormat;
    /** False models Gemini, which accepts a context write but issues no handle. */
    issueContextHandles?: boolean;
  }) {
    this.capabilities = params.capabilities;
    this.id = params.id ?? 'scripted';
    this.#inputFormat = params.inputFormat ?? PCM16_24K;
    this.#outputFormat = params.outputFormat ?? PCM16_24K;
    this.#issueContextHandles = params.issueContextHandles ?? true;
  }

  /** Behaviour for the next `open` calls, in order. */
  plan(...plans: ScriptedOpenPlan[]): void {
    this.#plans.push(...plans);
  }

  async open(
    config: UpstreamSessionConfig,
    onFact: (fact: UpstreamFact) => void,
  ): Promise<RealtimeUpstreamSession> {
    this.openConfigs.push(config);
    const plan = this.#plans.shift() ?? {};
    if (plan.gate) {
      await plan.gate;
    }
    if (plan.fail !== undefined) {
      throw new Error(plan.fail);
    }
    const session = new ScriptedUpstreamSession({
      capabilities: this.capabilities,
      config,
      onFact,
      inputFormat: plan.inputFormat ?? this.#inputFormat,
      outputFormat: plan.outputFormat ?? this.#outputFormat,
      generation: this.sessions.length + 1,
      issueContextHandles: this.#issueContextHandles,
    });
    this.sessions.push(session);
    if (plan.announceOpen !== false) {
      // Synchronously, before `open` resolves — the Nova ordering.
      session.announceOpen();
    }
    return session;
  }

  /** The session opened for a 1-based generation, or undefined if that open failed. */
  session(generation: number): ScriptedUpstreamSession | undefined {
    return this.sessions[generation - 1];
  }
}
