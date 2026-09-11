import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { LanguageModelUsage } from 'ai';
import { generateId, generateShortId } from '../types/id.ts';
import { isRecord } from '../util/type-guards.ts';
import { insertInjections } from './inject-messages.ts';
import type { Attachment, IAgentState } from './interfaces.ts';
import type { AgentMessagesListener } from '../sessions/produced-messages.ts';
import type { AgentContentListener } from '../sessions/produced-content.ts';
import type { AgentContent } from '../types/content.ts';
import { buildContentItems } from '../sessions/content-builder.ts';
import { toAgentContent } from '../sessions/session-manager.ts';
import { getAgentLogger } from '../types/logger.ts';

const logger = getAgentLogger();

/**
 * Stable per-message identity.
 *
 * History lives in two stores — `kernel.conversationHistory` and
 * `internal.stepMessages` — and `getConversationHistory()` concatenates them, so
 * a logical message must never sit in both. Every seam used to answer "is this
 * the same message?" by OBJECT REFERENCE, which compaction destroys:
 * `replaceKernelHistory` rewrites kernel history and the kept tail is rebuilt
 * into fresh objects (`truncateReasoningInKeptMessages` and
 * `neutralizeOversizedKeptResults` both return `{ ...msg }`). After that rewrite
 * every reference comparison against kernel silently reports "not present", and
 * the message is admitted a second time — reaching the provider twice.
 *
 * So identity is ASSIGNED on entry rather than inferred. It rides in
 * `providerOptions.agentplace.mid`, which means any transform that copies a
 * message by spreading it preserves identity without knowing this exists —
 * including the two compaction rebuilds above. Namespaced provider options are
 * consumed by the matching provider adapter and never reach the wire, the same
 * way `agentplace.injected` / `agentplace.type` already ride along.
 *
 * Content fingerprints were the alternative and are unsafe here: a tool-message
 * fingerprint keyed on `toolCallId` collapses two genuinely different calls
 * under OpenAI-compatible id recycling (AGE-378), and a byte-identical
 * fingerprint discards a model's legitimate repeat of the same call. An
 * assigned id has neither failure mode. See docs/history-identity/spec.md.
 */
/**
 * Length of an assigned message id.
 *
 * Ids ride in every prompt, so their size is a permanent tax on the cached
 * prefix — a full UUID measured at 4.7% of prompt bytes on a representative
 * builder scenario. Twelve hex characters is 2.8e14 values: across a thousand
 * messages in one session the birthday probability of a collision is ~2e-9,
 * and a collision would drop a real message as a duplicate, so the margin is
 * deliberately wide rather than minimal.
 */
const MESSAGE_ID_LENGTH = 12;

export function readMessageId(message: ModelMessage): string | null {
  const providerOptions = (message as { providerOptions?: unknown }).providerOptions;
  if (!isRecord(providerOptions)) return null;
  const agentplace = providerOptions['agentplace'];
  if (!isRecord(agentplace)) return null;
  const mid = agentplace['mid'];
  return typeof mid === 'string' ? mid : null;
}

/**
 * Assigns an id in place when the message does not already carry one.
 *
 * In place, because the runner re-passes the SAME message objects on every
 * `onStepFinish`: stamping a copy would mint a fresh id on each delivery and
 * defeat the purpose. Stamping the original makes it idempotent.
 */
export function stampMessageId(message: ModelMessage): ModelMessage {
  if (readMessageId(message) !== null) return message;
  const target = message as { providerOptions?: Record<string, unknown> };
  const providerOptions = isRecord(target.providerOptions) ? target.providerOptions : {};
  const agentplace = isRecord(providerOptions['agentplace']) ? providerOptions['agentplace'] : {};
  target.providerOptions = {
    ...providerOptions,
    agentplace: { ...agentplace, mid: generateShortId(MESSAGE_ID_LENGTH) },
  };
  return message;
}

/**
 * Membership test over an existing message list, by assigned id where both
 * sides carry one and by reference otherwise (history loaded from storage
 * predates stamping). One helper so the seams cannot drift apart again.
 */
function createPresenceIndex(
  messages: readonly ModelMessage[],
): (message: ModelMessage) => boolean {
  const ids = new Set<string>();
  const refs = new Set<ModelMessage>();
  for (const message of messages) {
    refs.add(message);
    const id = readMessageId(message);
    if (id !== null) ids.add(id);
  }
  return (message) => {
    if (refs.has(message)) return true;
    const id = readMessageId(message);
    return id !== null && ids.has(id);
  };
}

/**
 * Checks if a message is an assistant message containing at least one
 * non-provider-executed tool-call part.
 */
function hasClientToolCall(msg: ModelMessage): boolean {
  if ((msg as { role?: string }).role !== 'assistant') {
    return false;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part: { type?: string; providerExecuted?: boolean }) =>
      part.type === 'tool-call' && !part.providerExecuted,
  );
}

export type AgentKernelTurn = {
  lastUsage?: LanguageModelUsage;
  /**
   * The prior conversation in AI-SDK `ModelMessage` format.
   * This is **kernel-owned** and mandatory.
   */
  conversationHistory: ModelMessage[];
  /**
   * Kernel policy input: how many turns of history to include when building messages.
   */
  turnsLimit?: number;
  /**
   * Observability config that is owned by the agent/kernel (not product payload).
   * Example: trace display name.
   */
  trace?: {
    name?: string;
  };
  /**
   * Optional caller-supplied run identity. When provided it becomes the turn's
   * responseId (the durable run id); when omitted the runtime mints one. The
   * builder supplies the controller's responseId so claim + liveness +
   * currentRun + the client-facing id are a single identity.
   */
  responseId?: string;
};

/**
 * Library-defined, minimal "input" surface required for a turn.
 * Everything else is an application-owned payload (`app`) that the core runtime treats as opaque.
 */
/**
 * Explicit split between what the kernel owns vs what the application owns.
 * This makes extension points and responsibilities obvious.
 */
export type AgentTurnRequest<TApp = unknown> = {
  kernel: AgentKernelTurn;
  app?: TApp;
};

type AgentStateParamsT<TApp> = {
  kernel: Required<Pick<AgentKernelTurn, 'conversationHistory'>> & {
    turnsLimit: number;
    trace?: AgentKernelTurn['trace'];
    lastUsage?: LanguageModelUsage;
    responseId?: string;
  };
  app?: TApp;
  internal?: {
    lastUsage?: LanguageModelUsage;
  };
};

const DEFAULT_TURNS_LIMIT = 10;

export default class AgentState<TFrameworkState = unknown, TApp = unknown>
  implements IAgentState<TApp>
{
  /**
   * The conversation as one append-ordered list, with {@link #committedCount}
   * marking how much of it has been folded into durable history.
   *
   * Replaces a two-store model (`kernel.conversationHistory` plus a separate
   * `stepMessages` buffer) whose contents were concatenated on read. That shape
   * made "one logical message present twice" REPRESENTABLE, and four write
   * seams each enforced uniqueness differently — the root of AGE-351, AGE-367
   * and AGE-390. With a single list and a watermark, duplication cannot be
   * expressed rather than merely being prevented.
   *
   * Entries at or beyond the watermark belong to the stream in flight. The
   * watermark is a durability boundary only; the ordering of the list is the
   * conversation.
   */
  #entries: ModelMessage[] = [];
  #committedCount = 0;

  private kernel: {
    turnsLimit: number;
    trace?: { name?: string };
    traceId?: string;
  };

  private input: {
    instruction: string;
    responseId: string;
    attachments: Attachment[];
    modelId: string | null;
    provider: string | null;
  };

  private app?: TApp;

  private internal: {
    modelCallsCount: number;
    remindersCount: number;
    retriesCount: number;
    buildFixCount: number;
    continuationCount: number;
    error: Error | null;
    lastUsage?: LanguageModelUsage;
    runnerState: TFrameworkState | null;
    turnInputInjected: boolean;
    lastFinalPrompt?: LanguageModelV3Prompt;
    pendingStepInjections: { position: number; message: ModelMessage }[];
    forceFullTruncation: boolean;
    truncationEscalationLevel: number;
    compactionOccurred: boolean;
    /** First kept message's `mid` from the latest compaction; null when none. */
    compactionBoundaryMid: string | null;
    /** Summary from the durable compaction record loaded at session start. */
    loadedCompactionSummary: string | null;
    /** Summary text produced by the latest compaction, for the durable record. */
    compactionSummary: string | null;
  };

  private constructor({ kernel, app, internal }: AgentStateParamsT<TApp>) {
    this.#entries = [...(kernel.conversationHistory ?? [])];
    this.#committedCount = this.#entries.length;
    this.kernel = {
      turnsLimit: kernel.turnsLimit ?? DEFAULT_TURNS_LIMIT,
      trace: kernel.trace,
      traceId: undefined,
    };

    this.input = {
      instruction: '',
      responseId: kernel.responseId ?? generateId(),
      attachments: [],
      modelId: null,
      provider: null,
    };
    this.app = app;

    this.internal = {
      modelCallsCount: 0,
      remindersCount: 0,
      retriesCount: 0,
      buildFixCount: 0,
      continuationCount: 0,
      error: null,
      lastUsage: undefined,
      runnerState: null,
      turnInputInjected: false,
      lastFinalPrompt: undefined,
      pendingStepInjections: [],
      forceFullTruncation: false,
      truncationEscalationLevel: 0,
      compactionOccurred: false,
      compactionBoundaryMid: null,
      loadedCompactionSummary: null,
      compactionSummary: null,
      ...internal,
    };
  }

  /**
   * Library-style factory for creating an AgentState for a single agent turn.
   * The request is explicitly split into `kernel` vs `app` inputs.
   */
  static createTurn<TFrameworkState = unknown, TApp = unknown>(
    request: AgentTurnRequest<TApp>,
  ): AgentState<TFrameworkState, TApp> {
    if (!request?.kernel?.conversationHistory) {
      throw new Error('AgentState.createTurn() requires request.kernel.conversationHistory');
    }
    return new AgentState<TFrameworkState, TApp>({
      kernel: {
        conversationHistory: request.kernel.conversationHistory,
        turnsLimit: request.kernel.turnsLimit ?? DEFAULT_TURNS_LIMIT,
        trace: request.kernel.trace,
        responseId: request.kernel.responseId,
      },
      internal: {
        lastUsage: request.kernel.lastUsage,
      },
      app: request.app,
    });
  }

  getRunnerState(): TFrameworkState | null {
    return this.internal.runnerState;
  }

  setRunnerState(state: TFrameworkState | null): void {
    this.internal.runnerState = state;
  }

  getAppContext(): TApp | null {
    return this.app ?? null;
  }

  setAppContext(ctx: TApp | null): void {
    this.app = ctx ?? undefined;
  }

  getApp<T = TApp>(): T | undefined {
    return this.app as unknown as T | undefined;
  }

  setApp<T = TApp>(payload: T | undefined): void {
    this.app = payload as unknown as TApp | undefined;
  }

  getTraceConfig(): { name?: string } | undefined {
    return this.kernel.trace;
  }

  setTraceConfig(trace: { name?: string } | undefined): void {
    this.kernel.trace = trace;
  }

  getTraceId(): string | undefined {
    return this.kernel.traceId;
  }

  setTraceId(traceId: string | undefined): void {
    this.kernel.traceId = traceId;
  }

  getUserQueryText(): string | undefined {
    return this.input.instruction;
  }

  setUserQueryText(instruction: string): void {
    this.input.instruction = instruction ?? '';
    this.internal.turnInputInjected = false;
  }

  setError(error: Error | null) {
    this.internal.error = error;
  }

  getError(): Error | null {
    return this.internal.error;
  }

  setLastUsage(usage: LanguageModelUsage | null | undefined): void {
    this.internal.lastUsage = usage ?? undefined;
  }

  getLastUsage(): LanguageModelUsage | undefined {
    return this.internal.lastUsage;
  }

  getBuildFixCount(): number {
    return this.internal.buildFixCount;
  }

  increaseBuildFixCount() {
    this.internal.buildFixCount += 1;
  }

  increaseModelCallsCount(byNumber: number = 1) {
    this.internal.modelCallsCount += byNumber;
  }

  getModelCallsCount() {
    return this.internal.modelCallsCount;
  }

  increaseRetriesCount() {
    this.internal.retriesCount += 1;
  }

  getRetriesCount() {
    return this.internal.retriesCount;
  }

  getRemindersCount() {
    return this.internal.remindersCount;
  }

  getModelId(): string | null {
    return this.input.modelId ?? null;
  }

  setModelId(modelId: string | null): void {
    this.input.modelId = modelId ?? null;
  }

  getProvider(): string | null {
    return this.input.provider ?? null;
  }

  setProvider(provider: string | null): void {
    this.input.provider = provider ?? null;
  }

  getResponseId(): string {
    return this.input.responseId;
  }

  getAttachments(): Attachment[] {
    return this.input.attachments ?? [];
  }

  setAttachments(attachments: Attachment[] | undefined): void {
    this.input.attachments = attachments ?? [];
    this.internal.turnInputInjected = false;
  }

  hasTurnInputInjected(): boolean {
    return this.internal.turnInputInjected;
  }

  markTurnInputInjected(): void {
    this.internal.turnInputInjected = true;
  }

  /**
   * Capture the final prompt that will be sent to the model after all middleware transformations.
   * Useful for debugging and observability.
   */
  setLastFinalPrompt(prompt: LanguageModelV3Prompt | undefined): void {
    this.internal.lastFinalPrompt = prompt;
  }

  getLastFinalPrompt(): LanguageModelV3Prompt | undefined {
    return this.internal.lastFinalPrompt;
  }

  getForceFullTruncation(): boolean {
    return this.internal.forceFullTruncation;
  }

  setForceFullTruncation(force: boolean): void {
    this.internal.forceFullTruncation = force;
  }

  /** Truncation pressure escalation level (0 = normal, higher = more aggressive). */
  getTruncationEscalationLevel(): number {
    return this.internal.truncationEscalationLevel;
  }

  /** Increment the truncation escalation level and return the new value. */
  increaseTruncationEscalationLevel(): number {
    this.internal.truncationEscalationLevel += 1;
    return this.internal.truncationEscalationLevel;
  }

  resetTruncationEscalationLevel(): void {
    this.internal.truncationEscalationLevel = 0;
  }

  setCompactionOccurred(value: boolean): void {
    this.internal.compactionOccurred = value;
  }

  /**
   * Assigned id of the first message KEPT by the most recent compaction — where
   * a renderer resumes emitting after the summary.
   *
   * A `mid` rather than a sequence number. `CheckpointData.firstKeptSeq` exists
   * for this and is inert, because the seq is the DDB sort key assigned at write
   * time: neither a kernel `ModelMessage` nor a `ConversationMessage` carries
   * one, so the middleware that decides the cut has no seq to record. The id is
   * ours by construction, known exactly where the decision is taken, and
   * survives persistence — see docs/history-architecture/design.md §4.
   */
  setCompactionBoundaryMid(mid: string | null): void {
    this.internal.compactionBoundaryMid = mid;
  }

  getCompactionBoundaryMid(): string | null {
    return this.internal.compactionBoundaryMid ?? null;
  }

  /**
   * Summary carried by the durable compaction record, seeded at session load.
   *
   * Compaction otherwise recovers the prior summary only by finding a
   * `compaction-summary` message in the collapsed region, which survives just
   * as long as the kernel rewrite keeps one there. When it is missing the
   * summarizer restarts from nothing — losing everything the earlier summary
   * knew and rewriting the cached prefix from the collapse point on.
   */
  /**
   * Summary text the latest compaction produced.
   *
   * Recorded here rather than recovered by scanning history: the summary appears
   * in history only because `replaceKernelHistory` puts it there, so sourcing it
   * that way makes the durable record a derivative of the rewrite. Removing the
   * rewrite would then empty the record silently.
   */
  setCompactionSummary(summary: string | null): void {
    this.internal.compactionSummary = summary;
  }

  getCompactionSummary(): string | null {
    return this.internal.compactionSummary ?? null;
  }

  setLoadedCompactionSummary(summary: string | null): void {
    this.internal.loadedCompactionSummary = summary;
  }

  getLoadedCompactionSummary(): string | null {
    return this.internal.loadedCompactionSummary ?? null;
  }

  getCompactionOccurred(): boolean {
    return this.internal.compactionOccurred;
  }

  getContinuationCount(): number {
    return this.internal.continuationCount;
  }

  increaseContinuationCount(): void {
    this.internal.continuationCount += 1;
  }

  resetContinuationCount(): void {
    this.internal.continuationCount = 0;
  }

  /**
   * Replace kernel history without clearing in-progress stepMessages.
   * Safe to call mid-turn (during tool loop).
   */
  /**
   * Seed kernel history without clearing in-progress stepMessages.
   *
   * **Not part of the `AgentState` contract, deliberately.** This was the
   * destructive rewrite compaction used to perform; Phase 5 replaced it with a
   * compaction record rendered at read time, and no production code path calls
   * it any more. It stays on the concrete class because lab tooling and tests
   * need a way to seed committed history, and it was removed from
   * `interfaces.ts` so nothing typed to the contract can reintroduce the
   * rewrite that Phase 5 removed.
   *
   * If you are reaching for this from production code, you want
   * `setCompactionBoundaryMid` + a compaction record instead.
   */
  replaceKernelHistory(history: ModelMessage[]): void {
    for (const message of history) {
      stampMessageId(message);
    }
    this.#entries = [...history, ...this.#uncommitted()];
    this.#committedCount = history.length;
  }

  /** Entries belonging to the stream in flight — everything past the watermark. */
  #uncommitted(): ModelMessage[] {
    return this.#entries.slice(this.#committedCount);
  }

  getConversationHistory(): ModelMessage[] {
    return this.#entries;
  }

  getKernelConversationHistory(): ModelMessage[] {
    return this.#entries.slice(0, this.#committedCount);
  }

  getStepMessages(): ModelMessage[] {
    return this.#uncommitted();
  }

  /**
   * Records the current stream's messages, dropping any already folded into
   * kernel history.
   *
   * A stream that ends — including one aborted by a retryable error — commits
   * its step messages and clears this buffer, but its tee'd drain can still
   * fire afterwards and re-pass the same objects. Admitting them back made
   * every later prompt of that turn carry them twice, once from kernel history
   * and once from this buffer, since `getConversationHistory()` concatenates
   * the two (AGE-390). Membership is keyed on assigned id, so a compaction
   * rebuild of kernel history does not reopen the hole the way a reference
   * test did.
   */
  setStepMessages(stepMessages: ModelMessage[]): void {
    if (!Array.isArray(stepMessages) || stepMessages.length === 0) {
      return;
    }
    for (const message of stepMessages) {
      stampMessageId(message);
    }
    const isCommitted = createPresenceIndex(this.getKernelConversationHistory());
    const uncommitted = stepMessages.filter((m) => !isCommitted(m));
    if (uncommitted.length === 0) {
      return;
    }
    const delta = uncommitted
      .slice(this.#uncommitted().length)
      .filter((m) => !this.#emittedStepMessages.has(m));
    this.#entries = [...this.getKernelConversationHistory(), ...uncommitted];
    for (const message of delta) {
      this.#emittedStepMessages.add(message);
    }
    this.emitMessages(delta);
  }

  /**
   * Messages already emitted to durable storage this turn, by object identity.
   * The positional slice defines what is new within a live stream; this set
   * guards the late-delivery race (a tee'd stream drain firing after
   * commitStepMessages reset the buffer to length 0, where a bare positional
   * delta would re-emit the whole run). The runner re-passes the same message
   * objects on every onStepFinish, so reference identity is sound here —
   * AGE-351's rebuild hazard lives at the turn-start processor seam, not
   * this one.
   */
  #emittedStepMessages = new WeakSet<object>();

  /**
   * Folds the current stream's messages into kernel history.
   *
   * Uses the same membership test as {@link setStepMessages}, so the two seams
   * cannot answer "is this the same message?" differently. It previously
   * compared by reference and then merely warned on a content-fingerprint
   * overlap while committing anyway; that fingerprint was never safe to promote
   * to a filter, since it collapses distinct calls under recycled tool ids
   * (AGE-378). The assigned id replaces both.
   */
  commitStepMessages(): void {
    const pending = this.#uncommitted();
    if (pending.length === 0) {
      return;
    }
    const isCommitted = createPresenceIndex(this.getKernelConversationHistory());
    const messages = pending.filter((m) => !isCommitted(m));
    const skipped = pending.length - messages.length;
    if (skipped > 0) {
      logger.warn('[AgentState] commitStepMessages: skipped already-committed step messages', {
        skipped,
      });
    }
    if (messages.length === 0) {
      this.#entries = this.getKernelConversationHistory();
      return;
    }
    this.#entries = [...this.getKernelConversationHistory(), ...messages];
    this.#committedCount = this.#entries.length;
    this.#onMessagesCommitted?.(messages);
  }

  setPendingStepInjections(injections: { position: number; message: ModelMessage }[]): void {
    this.internal.pendingStepInjections = injections;

    // Record each injected message as it is queued (before its step runs), so it
    // lands in durable history at its real position — between the prior step and
    // the next — never batched at end-of-turn. The full accumulated list is
    // re-passed every step, so dedup by reference to record each message once.
    for (const injection of injections) {
      stampMessageId(injection.message);
    }
    const unrecorded = injections
      .map((i) => i.message)
      .filter((message) => !this.#emittedInjectedMessages.has(message));
    for (const message of unrecorded) {
      this.#emittedInjectedMessages.add(message);
    }
    if (unrecorded.length > 0) {
      this.emitMessages(unrecorded);
      this.#emitUserAuthoredInjections(unrecorded);
    }
  }

  /**
   * Surface user-authored injections on the content plane too.
   *
   * An injected message reaches the model via {@link emitMessages}; that is the
   * LLM plane only. A message the *user* injected mid-turn — a steer — is also
   * something they must see in the transcript, so it needs the UI plane as
   * well. System-authored injections (boundary context, compaction summaries)
   * are excluded by `buildContentItems` itself, which keys on authorship.
   *
   * Items are stamped with the run they were steered into, which is what keeps
   * one run rendering as one turn rather than splitting at the steer.
   */
  #emitUserAuthoredInjections(messages: ModelMessage[]): void {
    if (this.#onContentListeners.size === 0) {
      return;
    }
    const responseId = this.getResponseId();
    const items = messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => buildContentItems(message as Record<string, unknown>, responseId))
      .map((item) => toAgentContent(item))
      .filter((content): content is AgentContent => content !== null);
    this.emitContent(items);
  }

  #emittedInjectedMessages = new WeakSet<object>();

  /**
   * Insert pending step injections into stepMessages before commit.
   * Must be called BEFORE commitStepMessages().
   */
  commitPendingStepInjections(): void {
    const injections = this.internal.pendingStepInjections;
    if (injections.length === 0) {
      return;
    }

    // Guard against aborted/errored turns: if stepMessages is empty, we have
    // no step content to interleave reminders into. Discard pending injections
    // to avoid committing phantom reminders with no surrounding context.
    if (this.#uncommitted().length === 0) {
      this.internal.pendingStepInjections = [];
      return;
    }

    const enhanced = insertInjections(this.#uncommitted(), injections);

    this.#entries = [...this.getKernelConversationHistory(), ...enhanced];

    this.internal.pendingStepInjections = [];
  }

  setConversationHistory(history: ModelMessage[]): void {
    this.#entries = [...history];
    this.#committedCount = this.#entries.length;
  }

  hasConversationHistory(): boolean {
    return this.getConversationHistory().length > 0;
  }

  clearConversationHistory(): void {
    this.#entries = [];
    this.#committedCount = 0;
  }

  #onMessagesCommitted: ((messages: ModelMessage[]) => void) | null = null;

  onMessagesCommitted(cb: (messages: ModelMessage[]) => void): void {
    this.#onMessagesCommitted = cb;
  }

  #onMessagesListeners = new Set<AgentMessagesListener>();

  onMessages(cb: AgentMessagesListener): void {
    this.#onMessagesListeners.add(cb);
  }

  /**
   * Emit a batch of new messages (injected at turn 0, or a step's delta) to every
   * lifecycle listener, with the agent-only metadata needed to record them.
   */
  emitMessages(messages: ModelMessage[]): void {
    if (messages.length === 0 || this.#onMessagesListeners.size === 0) {
      return;
    }
    const event = {
      messages,
      responseId: this.getResponseId() || null,
      pendingToolCallIds: [...this.getPendingToolCallIds()],
    };
    for (const listener of this.#onMessagesListeners) {
      listener(event);
    }
  }

  #onContentListeners = new Set<AgentContentListener>();

  onContent(cb: AgentContentListener): void {
    this.#onContentListeners.add(cb);
  }

  /** Emit a batch of finalized UI content items to every content listener. */
  emitContent(items: AgentContent[]): void {
    if (items.length === 0 || this.#onContentListeners.size === 0) {
      return;
    }
    for (const listener of this.#onContentListeners) {
      listener({ items });
    }
  }

  #pendingToolCallIds = new Set<string>();

  markPendingToolCall(toolCallId: string): void {
    this.#pendingToolCallIds.add(toolCallId);
  }

  hasPendingToolCalls(): boolean {
    return this.#pendingToolCallIds.size > 0;
  }

  getPendingToolCallIds(): Set<string> {
    return new Set(this.#pendingToolCallIds);
  }

  clearPendingToolCalls(): void {
    this.#pendingToolCallIds.clear();
  }

  getTurnsLimit(): number {
    return this.kernel.turnsLimit;
  }

  /**
   * Finds and returns the system message content from conversation history if it exists
   * @returns The system message content or undefined if not found
   */
  findSystemMessageFromHistory(): string | undefined {
    if (!this.hasConversationHistory()) {
      return undefined;
    }

    const systemMessage = this.getConversationHistory().find(
      (item: any) => item.role === 'system',
    ) as any;

    return systemMessage?.content;
  }
}
