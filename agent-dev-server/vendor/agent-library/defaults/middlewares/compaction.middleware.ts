import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type {
  KernelModelMiddleware,
  KernelModelMiddlewareContext,
} from '../../kernel/middlewares/types.ts';
import { getAgentLogger } from '../../types/logger.ts';
import { firstPendingToolIndex } from '../../core/blocking.ts';
import { stampMessageId } from '../../core/agent-state.ts';
import { isRecord } from '../../util/type-guards.ts';
import type { TokenEstimator } from '../../util/token-estimator.ts';
import { LastUsageTokenEstimator } from '../../util/last-usage-token.estimator.ts';
import {
  estimateMessageTokens,
  estimatePromptTokensDetailed,
  estimateToolResultPartTokens,
} from '../../util/token-estimation.ts';
import {
  collectToolResultsForStorage,
  resolveCompactions,
  collapseBinaryToolResults,
  truncateUnstoredToolResults,
  clipOversizedToolResults,
  neutralizeOversizedKeptResults,
  isStoredReference,
  NEUTRALIZED_RESULT_ESTIMATE_TOKENS,
} from './tool-result-compaction.ts';
import {
  type CacheHintConfig,
  DEFAULT_CACHE_HINT_CONFIG,
  annotateCacheHints,
} from './cache-hint-annotation.ts';
import {
  hasAgentplaceType,
  getTextContent,
  isToolCallPart,
  isToolResultPart,
  isReasoningPart,
  getAgentplaceMetadata,
  isSystemAuthored,
  getToolResultString,
} from '../../kernel/utils/message-parts.ts';
import { serializeMessagesForNarrative } from './serialize-messages.ts';
import { validateCollapseSummary } from './summary-validation.ts';

const logger = getAgentLogger();

export type CollapsedPairInfo = {
  toolName: string;
  toolCallId: string;
  resultText?: string;
};

export type CollapseSummaryContext = {
  serializedNarrative: string;
  previousSummary: string | null;
  collapsedPairs: CollapsedPairInfo[];
};

export type CompactionOptions = {
  /** Activate when estimated prompt tokens >= this value. */
  triggerTokens?: number;
  /** Token budget for the kept "hot zone" after compaction. @default 30_000 */
  keepRecentTokens?: number;
  /**
   * Message-count trigger (AGE-378 follow-up, QA agent 2xyz5vl3omx8): fire
   * compaction when the non-system conversation reaches this many messages,
   * even while token pressure sits below `triggerTokens`. Scheduled sessions
   * accumulate thousands of micro-messages (~30 tokens each) that a
   * token-only trigger never sees. Optional — absent means token-only.
   */
  triggerMessages?: number;
  /**
   * Count bound for the kept region: the cut keeps at most this many recent
   * messages regardless of token budget. Applied inside the single safe cut
   * (pair-snapped) — NOT the removed post-summary `maxMessages` blind trim.
   */
  keepRecentMessages?: number;
  /**
   * Per-PART token threshold: kept tool-result parts above it are stored and
   * replaced with a re-readable pointer (clipped when storage is unavailable).
   * undefined disables neutralization.
   */
  maxSingleResultTokens?: number;
  /** Token estimator (shared with ContextBudgetGuardMiddleware). */
  estimator?: TokenEstimator;
  /** Generates the summary text for collapsed conversation narrative. */
  buildCollapseSummary?: (ctx: CollapseSummaryContext) => Promise<string> | string;
  /** Store a tool result to external storage and return a file reference path. */
  compactToolResult?: (
    toolCallId: string,
    toolName: string,
    content: string,
  ) => Promise<string | null>;
};

const DEFAULTS = {
  keepRecentTokens: 30_000,
} as const;

const KEPT_REASONING_RECENT_COUNT = 3;
const FORCED_ESCALATION_LEVEL = 2;
const FORCED_KEPT_TOOL_RESULT_MAX_CHARS = 20_000;

export function defaultCollapseSummary(pairs: CollapsedPairInfo[]): string {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    counts.set(p.toolName, (counts.get(p.toolName) ?? 0) + 1);
  }
  const summary = Array.from(counts.entries())
    .map(([name, count]) => (count > 1 ? `${name} (x${count})` : name))
    .join(', ');
  return `<system-reminder>[${pairs.length} earlier tool iterations collapsed: ${summary}]</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Cut point algorithm
// ---------------------------------------------------------------------------

/**
 * System-authored messages are skipped when looking for the most recent real
 * message. Named for the property that matters here — a user-authored injected
 * message (a steer) IS a real message and must not be skipped.
 */
function isInjectedMessage(msg: LanguageModelV3Message | ModelMessage): boolean {
  return isSystemAuthored(msg);
}

function boundaryFingerprint(msg: LanguageModelV3Message): string {
  try {
    return (JSON.stringify(msg.content) ?? '').slice(0, 128);
  } catch {
    return '';
  }
}

/**
 * Size of a reused projection when it has itself outgrown the trigger, else null.
 *
 * Measures the prompt that would be SENT, not the incoming history. The incoming
 * prompt only grows, so a trigger measured on it reads as over-trigger forever
 * once crossed: under that predicate every post-cut step re-fires the summarizer
 * (AGE-365), and latching the cut to suppress that removed the growth bound with
 * it. Measured on the projection the trigger is self-limiting — quiet right after
 * a cut, vocal again only once the kept tail has regrown.
 *
 * Returns null when the keep window is not below the trigger. Such a config can
 * never bring the projection under it, so re-cutting is futile by construction
 * and would fire on every step.
 *
 * Uses `estimatePromptTokensDetailed` rather than the injected `TokenEstimator`.
 * `LastUsageTokenEstimator` returns max(last usage, heuristic), so a genuinely
 * smaller projection still reports the previous call's size and the bound never
 * engages. `AnthropicCountTokensEstimator` is a network call whose result cache
 * is keyed by prompt reference, which a freshly built projection misses every
 * time — one round-trip per step on the hot path.
 */
function projectionTokensIfOverTrigger(
  projection: LanguageModelV3Prompt,
  modelId: string | undefined,
  triggerTokens: number | undefined,
  keepRecentTokens: number,
): number | null {
  if (triggerTokens == null || keepRecentTokens >= triggerTokens) return null;
  const { tokens } = estimatePromptTokensDetailed(projection, modelId);
  return tokens >= triggerTokens ? tokens : null;
}

/**
 * The summary a new cut extends.
 *
 * A re-cut's memo summary outranks anything found in the conversation. This
 * middleware synthesizes summary messages and never writes them back, so the
 * only summary present in `collapsedRegion` is a PERSISTED one from an earlier
 * turn — older than what the current turn has already accumulated in its memo.
 * Reading the conversation first restarts the chain from that stale text on
 * every re-cut, silently dropping every link the turn built.
 */
function resolvePreviousSummary(
  recutSummary: string | null,
  collapsedRegion: readonly LanguageModelV3Message[],
  loadedSummary: string | null,
): string | null {
  if (recutSummary !== null) return recutSummary;
  for (const msg of collapsedRegion) {
    if (hasAgentplaceType(msg, 'compaction-summary')) {
      return getTextContent(msg) || loadedSummary;
    }
  }
  return loadedSummary;
}

/**
 * Message size as the model will actually receive it: tool-result parts that
 * neutralization will replace with a pointer count at the pointer's size, so
 * one oversized result cannot consume the whole keep budget and degenerate
 * the kept window.
 */
function effectiveMessageTokens(
  msg: LanguageModelV3Message | ModelMessage,
  model: string | undefined,
  resultCap: number | undefined,
): number {
  const full = estimateMessageTokens(msg, model);
  if (resultCap == null || msg.role !== 'tool' || !Array.isArray(msg.content)) {
    return full;
  }

  let reduction = 0;
  for (const part of msg.content) {
    if (!isToolResultPart(part)) continue;
    if (isStoredReference(part.output)) continue;
    if (getToolResultString(part.output) == null) continue;

    const partTokens = estimateToolResultPartTokens(part.output, model);
    if (partTokens > resultCap && partTokens > NEUTRALIZED_RESULT_ESTIMATE_TOKENS) {
      reduction += partTokens - NEUTRALIZED_RESULT_ESTIMATE_TOKENS;
    }
  }
  return Math.max(full - reduction, 0);
}

/**
 * Walk backwards from the end, accumulating token estimates.
 * Returns the index of the first message to KEEP in the conversation array
 * (everything before this index is collapsed).
 */
function findCutPoint(
  conversation: (LanguageModelV3Message | ModelMessage)[],
  keepRecentTokens: number,
  model?: string,
  resultCap?: number,
  keepRecentMessages?: number,
): number {
  let accumulated = 0;
  let freshestToolSeen = false;

  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    let cap = resultCap;
    // The freshest tool result is never neutralized — count it at real size.
    if (msg.role === 'tool' && !freshestToolSeen) {
      freshestToolSeen = true;
      cap = undefined;
    }
    accumulated += effectiveMessageTokens(msg, model, cap);

    const keptCount = conversation.length - i;
    if (
      accumulated >= keepRecentTokens ||
      (keepRecentMessages != null && keptCount >= keepRecentMessages)
    ) {
      return snapToValidCutPoint(conversation, i);
    }
  }

  // Entire conversation fits in budget — no compaction needed
  return 0;
}

/**
 * Snap a raw cut index to a pair-safe boundary: prefer scanning forward
 * (keeps less than budget), fall back to scanning backward (keeps slightly
 * more), and only return 0 ("compact nothing") when no boundary exists.
 */
function snapToValidCutPoint(
  messages: (LanguageModelV3Message | ModelMessage)[],
  nearIdx: number,
): number {
  for (let i = nearIdx; i < messages.length; i++) {
    if (isValidCutPoint(messages, i)) return clampCutToPendingBoundary(messages, i);
  }
  for (let i = nearIdx - 1; i > 0; i--) {
    if (isValidCutPoint(messages, i)) return clampCutToPendingBoundary(messages, i);
  }

  // Fallback: keep everything
  return 0;
}

/**
 * Never collapse past an unanswered blocking call.
 *
 * A `SelectOption`-style tool writes a placeholder tool result and pauses. The
 * user's answer is applied later by `applyResumeToolResults`, which finds the
 * call by scanning history for the pending marker — so if compaction collapses
 * the placeholder first (this middleware writes back via `replaceKernelHistory`,
 * so the collapse reaches stored truth), the resume finds nothing, reports
 * `hadPending: false`, and the answer is dropped with no error and no retry.
 *
 * An unanswered question is live context, not history. Cost of the rule: a
 * session parked on a blocking call pins the cut and cannot compact past it
 * until the call resolves or expires — deliberate, and preferable to silently
 * losing what the user chose. See docs/history-architecture/blocking-tools.md.
 */
function clampCutToPendingBoundary(
  messages: (LanguageModelV3Message | ModelMessage)[],
  cutIdx: number,
): number {
  const pendingIdx = firstPendingToolIndex(messages);
  if (pendingIdx < 0 || cutIdx <= pendingIdx) {
    return cutIdx;
  }
  for (let i = pendingIdx; i > 0; i--) {
    if (isValidCutPoint(messages, i)) return i;
  }
  return 0;
}

// Safe iff the first kept message is not a tool result — the only orphan shape
// Bedrock rejects; parallel calls are atomic (all results in one tool message).
function isValidCutPoint(
  messages: (LanguageModelV3Message | ModelMessage)[],
  idx: number,
): boolean {
  return messages[idx].role !== 'tool';
}

/**
 * Assigned id of a message, stamping one if it has none.
 *
 * The boundary must be resolvable, not best-effort. A message that entered the
 * session outside the stamping path — a seeded or imported history — would leave
 * the boundary null, and the snapshot then falls back to the FULL history,
 * silently undoing the compaction on the next turn.
 */
function ensureMid(message: ModelMessage | undefined): string | null {
  if (!message) return null;
  stampMessageId(message);
  const providerOptions = (message as { providerOptions?: unknown }).providerOptions;
  if (!isRecord(providerOptions)) return null;
  const agentplace = providerOptions['agentplace'];
  if (!isRecord(agentplace)) return null;
  const mid = agentplace['mid'];
  return typeof mid === 'string' ? mid : null;
}

function findLastRealUserIndex(conversation: (LanguageModelV3Message | ModelMessage)[]): number {
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i].role === 'user' && !isInjectedMessage(conversation[i])) return i;
  }
  return -1;
}

type PersistenceCutOptions = {
  budget: number;
  modelId: string | undefined;
  maxSingleResultTokens: number | undefined;
  keepRecentMessages: number | undefined;
  clampToLastUser: boolean;
};

/**
 * Mark the compaction so end-of-turn persistence can snapshot it.
 *
 * The cut is recomputed against history rather than reused from the prompt. Prompt indices do not
 * map onto history indices: the prompt carries injected reminders and middleware-reshaped messages
 * that never enter history, so a positional reuse would name the wrong boundary.
 *
 * The source is the FULL conversation — committed history plus the step messages of the stream in
 * flight. Committed history alone is not enough: within one request nothing has been committed
 * yet, so a session compacting during its first request finds nothing to cut, never reports the
 * compaction, and discards the summary it just paid to produce.
 *
 * The boundary id is taken from the kept region as history holds it, before any trimming. Trimming
 * copies the messages it rewrites, and an id stamped on a copy is one no later lookup can resolve.
 */
function recordCompactionForPersistence(
  state: KernelModelMiddlewareContext['state'],
  summaryText: string,
  cut: PersistenceCutOptions,
): void {
  const history = state.getConversationHistory?.() ?? [];
  const conversation = history.filter((message) => message.role !== 'system');
  if (conversation.length === 0) {
    return;
  }

  let cutIdx = findCutPoint(
    conversation,
    cut.budget,
    cut.modelId,
    cut.maxSingleResultTokens,
    cut.keepRecentMessages,
  );
  if (cut.clampToLastUser) {
    const lastUserIdx = findLastRealUserIndex(conversation);
    if (lastUserIdx >= 0 && cutIdx > lastUserIdx) {
      cutIdx = lastUserIdx;
    }
  }
  if (cutIdx <= 0) {
    return;
  }

  state.setCompactionOccurred?.(true);
  state.setCompactionBoundaryMid?.(ensureMid(conversation[cutIdx]));
  state.setCompactionSummary?.(summaryText);
}

const FALLBACK_USER_REQUEST_MAX_CHARS = 4000;

// The mechanical digest carries no user text, so without this a rejected
// summary would erase the instruction the collapsed region contained.
function lastCollapsedUserRequest(messages: LanguageModelV3Message[]): string | null {
  const idx = findLastRealUserIndex(messages);
  if (idx < 0) return null;
  const text = getTextContent(messages[idx]);
  if (!text) return null;
  const clipped =
    text.length > FALLBACK_USER_REQUEST_MAX_CHARS
      ? `${text.slice(0, FALLBACK_USER_REQUEST_MAX_CHARS)}…`
      : text;
  return `Last user request before compaction (verbatim):\n${clipped}`;
}

/**
 * Double-compaction guard: skip if the most recent non-system, non-injected
 * message is already a compaction summary (nothing new to summarize).
 */
function shouldSkipCompaction(conversation: LanguageModelV3Message[]): boolean {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    if (isInjectedMessage(msg)) continue;
    return hasAgentplaceType(msg, 'compaction-summary');
  }
  return false;
}

/**
 * Truncate reasoning/thinking blocks in older kept messages.
 * Keeps full reasoning in the most recent `recentCount` assistant messages.
 * Older assistant messages get reasoning truncated to `maxChars`.
 */
/**
 * Drops reasoning from kept messages older than `recentCount` assistant turns.
 *
 * Drops rather than shortens. A reasoning part carries an opaque provider signature computed over
 * its exact text, so a shortened part is not a smaller version of the original — it is one whose
 * signature no longer matches, which providers reject or ignore. Shortening also keeps paying for
 * a fragment the model cannot use, where dropping is free and is what providers document as
 * allowed outside a tool-use turn.
 *
 * A message whose only content is reasoning is left untouched: removing its last part would leave
 * an empty message and break the tool-call pairing around it.
 */
function dropReasoningInOlderKeptMessages<T extends LanguageModelV3Message | ModelMessage>(
  messages: T[],
  recentCount: number,
): T[] {
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') assistantCount++;
  }

  if (assistantCount <= recentCount) return messages;

  let seen = 0;
  const result: T[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      seen++;
      if (seen > recentCount && Array.isArray(msg.content)) {
        const withoutReasoning = msg.content.filter((part: unknown) => !isReasoningPart(part));
        if (withoutReasoning.length > 0 && withoutReasoning.length !== msg.content.length) {
          result.unshift({ ...msg, content: withoutReasoning } as T);
          continue;
        }
      }
    }
    result.unshift(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CompactionMiddleware
// ---------------------------------------------------------------------------

/**
 * Token-budget context compaction:
 *
 * 1. Trigger when estimated tokens >= triggerTokens
 * 2. Find cut point: walk backwards, keep keepRecentTokens of recent messages
 * 3. Stage A: store tool results before cut point via compactToolResult callback
 * 4. Stage B: serialize collapsed narrative, call buildCollapseSummary (LLM)
 * 5. Assemble: [system] + [summary] + [kept messages]
 * 6. Persist to kernel via an independently computed, pair-snapped kernel-space cut
 *
 * Storage failure in stage 3 defers the whole compaction (unstored results
 * have no other copy). At escalation >= FORCED_ESCALATION_LEVEL that flips to
 * forced mode: unstored results are truncated inline and oversized results in
 * the kept hot zone are clipped — losing data beats losing the run.
 */
export class CompactionMiddleware implements KernelModelMiddleware {
  #opts: Required<Pick<CompactionOptions, 'keepRecentTokens'>> & CompactionOptions;

  constructor(options: CompactionOptions = {}) {
    this.#opts = {
      ...options,
      keepRecentTokens: options.keepRecentTokens ?? DEFAULTS.keepRecentTokens,
    };
  }

  create(ctx: KernelModelMiddlewareContext): LanguageModelMiddleware {
    const {
      triggerTokens,
      triggerMessages,
      keepRecentTokens,
      keepRecentMessages,
      maxSingleResultTokens,
      estimator: injectedEstimator,
    } = this.#opts;

    const buildSummary: (ctx: CollapseSummaryContext) => Promise<string> | string =
      this.#opts.buildCollapseSummary ?? ((c) => defaultCollapseSummary(c.collapsedPairs));
    const compactCallback = this.#opts.compactToolResult ?? (async () => null);
    // Digest-only consumers (no real summarizer) get no carrier for the user's
    // instruction — never cut past their last real user message.
    const clampToLastUser = this.#opts.buildCollapseSummary == null;

    const estimator: TokenEstimator = injectedEstimator ?? new LastUsageTokenEstimator(ctx.state);

    const cacheHintConfig: CacheHintConfig = {
      ...DEFAULT_CACHE_HINT_CONFIG,
    };

    // Per-stream state: the create() closure lives exactly one kernel turn.
    // memo pins the first successful cut so later steps reuse the summary
    // instead of re-running the summarizer on every over-trigger step.
    const pointerCache = new Map<string, string>();
    let memo: {
      cutIdx: number;
      boundaryRole: string;
      boundaryFingerprint: string;
      summaryMessage: LanguageModelV3Message;
      /** Kept-region length at firing — the finalization frontier (AGE-379). */
      finalizeFrontier: number;
    } | null = null;

    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        const opts = params as LanguageModelV3CallOptions;
        const escalation = ctx.state.getTruncationEscalationLevel?.() ?? 0;
        const forced = escalation >= FORCED_ESCALATION_LEVEL;

        // Always annotate cache hints
        annotateCacheHints(opts.prompt, cacheHintConfig);

        if (triggerTokens == null && triggerMessages == null && escalation === 0) {
          return opts;
        }

        const modelId = ctx.state.getModelId?.() ?? undefined;
        const estimation = await estimator.estimate(
          opts,
          modelId,
          ctx.state.getProvider?.() ?? undefined,
        );
        const pressure = estimation.tokens > 0 ? estimation.tokens : undefined;

        const overTokenTrigger =
          triggerTokens != null && pressure != null && pressure >= triggerTokens;
        const nonSystemCount = opts.prompt.filter((m) => m.role !== 'system').length;
        const overMessageTrigger = triggerMessages != null && nonSystemCount >= triggerMessages;
        if (escalation === 0 && !overTokenTrigger && !overMessageTrigger) {
          return opts;
        }

        // Separate system messages from conversation
        const systemMsgs: LanguageModelV3Message[] = [];
        const conversation: LanguageModelV3Message[] = [];
        for (const msg of opts.prompt) {
          if (msg.role === 'system') {
            systemMsgs.push(msg as LanguageModelV3Message);
          } else {
            conversation.push(msg as LanguageModelV3Message);
          }
        }

        // Double-compaction guard
        if (shouldSkipCompaction(conversation)) {
          return opts;
        }

        // For overflow recovery, halve the budget
        const effectiveBudget =
          escalation > 0 ? Math.floor(keepRecentTokens / 2) : keepRecentTokens;

        const finalizeKept = async (kept: LanguageModelV3Message[]) => {
          let trimmed = dropReasoningInOlderKeptMessages(kept, KEPT_REASONING_RECENT_COUNT);
          let neutralizedCount = 0;
          if (maxSingleResultTokens != null) {
            const neutralized = await neutralizeOversizedKeptResults(
              trimmed,
              maxSingleResultTokens,
              modelId,
              compactCallback,
              pointerCache,
            );
            trimmed = neutralized.messages;
            neutralizedCount = neutralized.neutralizedCount;
          }
          if (forced) {
            trimmed = clipOversizedToolResults(trimmed, FORCED_KEPT_TOOL_RESULT_MAX_CHARS);
          }
          return { trimmed, neutralizedCount };
        };

        /**
         * Set when the memo's own projection has outgrown the trigger and a
         * re-cut is warranted.
         *
         * `fallbackPrompt` is returned unchanged when the recomputed cut fails to
         * advance past `previousCutIdx`: nothing new can be collapsed there, so
         * re-summarizing would buy no reduction while spending a summarizer call
         * every step, which is the AGE-365 defect.
         *
         * `previousSummary` carries the memo's summary into the next one. On a
         * re-cut the earlier summary exists only in the memo — this middleware
         * synthesizes the summary message and never writes it back — so without
         * it the turn's second cut summarizes from scratch and silently drops
         * everything the first one carried.
         */
        let recut: {
          fallbackPrompt: LanguageModelV3Message[];
          previousCutIdx: number;
          previousSummary: string | null;
        } | null = null;

        if (memo !== null) {
          const boundary = conversation[memo.cutIdx - 1];
          const boundaryValid =
            conversation.length > memo.cutIdx &&
            boundary != null &&
            boundary.role === memo.boundaryRole &&
            boundaryFingerprint(boundary) === memo.boundaryFingerprint;

          if (boundaryValid) {
            const keptRegion = conversation.slice(memo.cutIdx);
            // Frozen kept-tail (AGE-379): finalize only the at-firing prefix,
            // with windows computed over that prefix alone — running
            // finalizeKept on it reproduces the firing-time bytes by
            // determinism. Post-frontier messages skip the two end-anchored
            // churn mechanisms (reasoning truncation, neutralization); the
            // forced clip is per-message pure and still applies everywhere.
            const frozen = keptRegion.slice(0, memo.finalizeFrontier);
            const postFrontier = keptRegion.slice(memo.finalizeFrontier);
            const { trimmed: frozenTrimmed } = await finalizeKept(frozen);
            const postTail = forced
              ? clipOversizedToolResults(postFrontier, FORCED_KEPT_TOOL_RESULT_MAX_CHARS)
              : postFrontier;
            const reusedPrompt: LanguageModelV3Message[] = [
              ...systemMsgs,
              memo.summaryMessage,
              ...frozenTrimmed,
              ...postTail,
            ];
            annotateCacheHints(reusedPrompt as LanguageModelV3Prompt, cacheHintConfig);

            const projectedTokens = projectionTokensIfOverTrigger(
              reusedPrompt as LanguageModelV3Prompt,
              modelId,
              triggerTokens,
              keepRecentTokens,
            );

            if (projectedTokens === null) {
              logger.info('[Compaction] Reused within-stream summary', {
                cutIdx: memo.cutIdx,
                keptMessages: keptRegion.length,
              });
              return { ...opts, prompt: reusedPrompt as LanguageModelV3Prompt };
            }

            logger.info('[Compaction] Kept tail regrew past trigger, re-cutting', {
              cutIdx: memo.cutIdx,
              keptMessages: keptRegion.length,
              projectedTokens,
              triggerTokens,
            });
            recut = {
              fallbackPrompt: reusedPrompt,
              previousCutIdx: memo.cutIdx,
              previousSummary: getTextContent(memo.summaryMessage) || null,
            };
          } else {
            memo = null;
          }
        }

        // Find cut point
        let cutIdx = findCutPoint(
          conversation,
          effectiveBudget,
          modelId,
          maxSingleResultTokens,
          keepRecentMessages,
        );

        if (clampToLastUser) {
          const lastUserIdx = findLastRealUserIndex(conversation);
          if (lastUserIdx >= 0 && cutIdx > lastUserIdx) {
            cutIdx = lastUserIdx;
          }
        }

        if (recut !== null && cutIdx <= recut.previousCutIdx) {
          return { ...opts, prompt: recut.fallbackPrompt as LanguageModelV3Prompt };
        }

        // Nothing to collapse
        if (cutIdx === 0) {
          return opts;
        }

        const collapsedRegion = conversation.slice(0, cutIdx);
        const keptRegion = conversation.slice(cutIdx);

        const previousSummary = resolvePreviousSummary(
          recut?.previousSummary ?? null,
          collapsedRegion,
          ctx.state.getLoadedCompactionSummary?.() ?? null,
        );

        // Stage A: store tool results in collapsed region
        const pending = collectToolResultsForStorage(collapsedRegion, 0, collapsedRegion.length);
        const { messages: storedRegion, failedCount } = await resolveCompactions(
          [...collapsedRegion],
          pending,
          compactCallback,
        );

        if (this.#opts.compactToolResult && failedCount > 0) {
          if (!forced) {
            logger.warn('[Compaction] Deferred — tool-result storage failed', {
              failedCount,
              pendingCount: pending.length,
            });
            return opts;
          }
          logger.warn('[Compaction] Forced mode — truncating unstored tool results', {
            failedCount,
          });
          truncateUnstoredToolResults(storedRegion);
        }

        // Stage A.5: collapse binary tool results (screenshots, images) in cold zone
        collapseBinaryToolResults(storedRegion);

        // Build CollapsedPairInfo metadata
        const collapsedPairs: CollapsedPairInfo[] = [];
        for (let i = 0; i < storedRegion.length - 1; i++) {
          if (storedRegion[i].role === 'assistant' && storedRegion[i + 1].role === 'tool') {
            const parts: unknown[] = Array.isArray(storedRegion[i].content)
              ? (storedRegion[i].content as unknown[])
              : [];
            const callPart = parts.find(isToolCallPart);
            collapsedPairs.push({
              toolName: callPart?.toolName ?? 'unknown',
              toolCallId: callPart?.toolCallId ?? 'unknown',
            });
          }
        }

        // Stage B: serialize narrative and summarize
        const messagesForNarrative = storedRegion.filter(
          (m) => !hasAgentplaceType(m, 'compaction-summary'),
        );
        const serializedNarrative = serializeMessagesForNarrative(messagesForNarrative);

        // Chain-preserving fallback: a rejected/failed summary must not erase
        // the accumulated previous summary — degrade only the new region.
        const fallbackSummary = () => {
          const digest = defaultCollapseSummary(collapsedPairs);
          const parts = [previousSummary, lastCollapsedUserRequest(storedRegion), digest];
          return parts.filter(Boolean).join('\n\n');
        };

        let summaryText: string;
        try {
          summaryText = await buildSummary({
            serializedNarrative,
            previousSummary,
            collapsedPairs,
          });
          const verdict = validateCollapseSummary(summaryText);
          if (verdict.ok === false) {
            logger.warn('[Compaction] Summary rejected, using fallback', {
              reason: verdict.reason,
              length: summaryText.length,
            });
            summaryText = fallbackSummary();
          }
        } catch (error) {
          if (escalation === 0) {
            logger.warn('[Compaction] Summarizer failed — deferring collapse to a later step', {
              error: error instanceof Error ? error.message : String(error),
            });
            return opts;
          }
          summaryText = fallbackSummary();
        }

        // Build summary message with metadata
        const summaryMessage: LanguageModelV3Message = {
          role: 'user',
          content: [{ type: 'text', text: summaryText }],
          providerOptions: {
            agentplace: {
              injected: true,
              authored: 'system',
              type: 'compaction-summary',
              keptMessageCount: keptRegion.length,
            },
          },
        } as unknown as LanguageModelV3Message;

        const { trimmed: trimmedKept, neutralizedCount } = await finalizeKept(keptRegion);

        const finalPrompt: LanguageModelV3Message[] = [
          ...systemMsgs,
          summaryMessage,
          ...trimmedKept,
        ];

        annotateCacheHints(finalPrompt as LanguageModelV3Prompt, cacheHintConfig);

        logger.info('[Compaction] Applied', {
          escalation,
          collapsedMessages: collapsedRegion.length,
          keptMessages: keptRegion.length,
          storedResults: pending.length,
          neutralizedResults: neutralizedCount,
        });

        recordCompactionForPersistence(ctx.state, summaryText, {
          budget: effectiveBudget,
          modelId,
          maxSingleResultTokens,
          keepRecentMessages,
          clampToLastUser,
        });

        const promptBoundary = conversation[cutIdx - 1];
        if (promptBoundary != null) {
          memo = {
            cutIdx,
            boundaryRole: promptBoundary.role,
            boundaryFingerprint: boundaryFingerprint(promptBoundary),
            summaryMessage,
            finalizeFrontier: keptRegion.length,
          };
        }

        return { ...opts, prompt: finalPrompt as LanguageModelV3Prompt };
      },
    };
  }
}
