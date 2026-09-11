/**
 * Single source of the deployed agent's context-management wiring: the
 * model-middleware stack (compaction → cache → budget guard) and tool-result
 * offloading config. Consumed by the chat path (MessagingService), the
 * channel path (createAgent buildRunConfig hook), and subagents — keep all
 * three on this factory so no execution path runs unprotected.
 *
 * Sessions without a sessionKey get NO offloading: tool results stay inline
 * rather than falling into a shared storage bucket (session isolation rule).
 */
import type { ModelProvider } from '../agent/interfaces.ts';
import type { AgentStorage } from '../../../vendor/agent-library/storage/agent-storage.ts';
import type { FileFirstConfig } from '../../../vendor/agent-library/core/file-first-offloader.ts';
import type { KernelModelMiddleware } from '../../../vendor/agent-library/kernel/middlewares/types.ts';
import { resolveContextPlan } from './model-context-plan.ts';
import { CompactionMiddleware } from '../../../vendor/agent-library/defaults/middlewares/compaction.middleware.ts';
import { InterleavedThinkingFixMiddleware } from '../../../vendor/agent-library/defaults/middlewares/interleaved-thinking-fix.middleware.ts';
import { BrokenToolInputFixMiddleware } from '../../../vendor/agent-library/defaults/middlewares/broken-tool-input-fix.middleware.ts';
import { ContextBudgetGuardMiddleware } from '../../../vendor/agent-library/defaults/middlewares/context-budget-guard.middleware.ts';
import {
  CacheStrategyMiddleware,
  CacheStrategyFactory,
  ReasoningStreamFixMiddleware,
} from '../agent/agent-library.ts';
import { HeuristicTokenEstimator } from '../../../vendor/agent-library/util/token-estimator.ts';
import { formatToolResultForStorage } from '../../../vendor/agent-library/core/tool-result-format.ts';
import { createTokenEstimator } from './token-estimator.factory.ts';
import { createAgentCompactionSummarizer } from './agent-compaction-summarizer.ts';

const OFFLOAD_THRESHOLD_CHARS = 15_000;
const PREVIEW_HEAD_LINES = 20;
const PREVIEW_TAIL_LINES = 10;
const PREVIEW_LINE_MAX_CHARS = 1000;
const MAX_SINGLE_RESULT_TOKENS = 15_000;

export type ContextManagementParams = {
  modelName: string;
  storage: AgentStorage;
  sessionKey?: string;
  /** Per-context compaction-history scope: 'main' or a per-invocation subagent value. */
  compactionScope: string;
  modelProvider: ModelProvider;
  gatewayBaseUrl: string;
  accessKey: string;
};

export type ContextManagement = {
  modelMiddlewares: KernelModelMiddleware[];
  /** undefined when offloading is disabled (no sessionKey). */
  fileFirstConfig?: FileFirstConfig;
};

/**
 * Builds the middleware stack and offload config for one agent run.
 *
 * Heuristic-only providers (grok/openrouter/unknown) get no injected
 * estimator: CompactionMiddleware then falls back to LastUsageTokenEstimator
 * (actual provider-reported usage) and ContextBudgetGuardMiddleware to its
 * own model-aware heuristic, instead of both running the bare
 * HeuristicTokenEstimator.
 */
export function createContextManagement(params: ContextManagementParams): ContextManagement {
  const {
    modelName,
    storage,
    sessionKey,
    compactionScope,
    modelProvider,
    gatewayBaseUrl,
    accessKey,
  } = params;

  const plan = resolveContextPlan(modelName);
  const estimator = createTokenEstimator(modelName, { gatewayBaseUrl, accessKey });
  const offloadEnabled = Boolean(sessionKey);

  const isHeuristicOnly = estimator instanceof HeuristicTokenEstimator;
  const sharedEstimator = isHeuristicOnly ? undefined : estimator;

  const writeToolResult = async (filePath: string, content: string): Promise<boolean> => {
    try {
      await storage.writeFile(filePath, Buffer.from(content, 'utf-8'));
      return true;
    } catch {
      return false;
    }
  };

  const modelMiddlewares: KernelModelMiddleware[] = [
    new InterleavedThinkingFixMiddleware(),
    new BrokenToolInputFixMiddleware(),
    new ReasoningStreamFixMiddleware(),
    new CompactionMiddleware({
      triggerTokens: plan.triggerTokens,
      keepRecentTokens: plan.keepRecentTokens,
      maxSingleResultTokens: MAX_SINGLE_RESULT_TOKENS,
      estimator: sharedEstimator,
      compactToolResult: offloadEnabled
        ? async (toolCallId: string, _toolName: string, content: string) => {
            const storagePath = `tool-results/${toolCallId}.txt`;
            const ok = await writeToolResult(storagePath, formatToolResultForStorage(content));
            return ok ? storagePath : null;
          }
        : undefined,
      buildCollapseSummary: createAgentCompactionSummarizer(modelProvider, {
        storage,
        sessionKey,
        compactionScope,
      }),
    }),
    new CacheStrategyMiddleware(new CacheStrategyFactory()),
    new ContextBudgetGuardMiddleware({
      maxTokens: plan.contextBudgetTokens,
      estimator: sharedEstimator,
      model: isHeuristicOnly ? modelName : undefined,
    }),
  ];

  const fileFirstConfig: FileFirstConfig | undefined = offloadEnabled
    ? {
        offloadThreshold: OFFLOAD_THRESHOLD_CHARS,
        previewHeadLines: PREVIEW_HEAD_LINES,
        previewTailLines: PREVIEW_TAIL_LINES,
        previewLineMaxChars: PREVIEW_LINE_MAX_CHARS,
        write: writeToolResult,
      }
    : undefined;

  return { modelMiddlewares, fileFirstConfig };
}
