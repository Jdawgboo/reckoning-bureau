import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type {
  KernelModelMiddleware,
  KernelModelMiddlewareContext,
} from '../../kernel/middlewares/types.ts';
import { getAgentLogger } from '../../types/logger.ts';
import { estimateTokensDetailed } from '../../util/token-estimation.ts';
import type { TokenEstimator } from '../../util/token-estimator.ts';

const logger = getAgentLogger();

export type ContextBudgetGuardOptions = {
  /**
   * Maximum estimated prompt tokens.
   * If the prompt exceeds this, the middleware throws an error containing
   * "too long" which triggers the existing escalation mechanism in the agent loop.
   * Escalation causes CompactionMiddleware to run more aggressively
   * on retry (tool-result truncation + collapse with a halved keep window).
   *
   * This middleware never truncates by itself — it is a pure check. Recovery
   * is owned by CompactionMiddleware: escalation levels 1+ compact more
   * aggressively, and at escalation ≥ 2 forced mode hard-truncates unstored
   * and oversized tool results so the loop cannot wedge on retries.
   */
  maxTokens: number;

  /**
   * Model name for model-specific token estimation ratio (e.g. 'claude-sonnet-4-6').
   * Only used when no `estimator` is set. Falls back to a conservative default if not set.
   */
  model?: string;

  /**
   * Custom token estimator. When set, takes precedence over the built-in heuristic.
   *
   * Use `AnthropicCountTokensEstimator` for exact counting via Anthropic's count_tokens API,
   * or provide any `TokenEstimator` implementation for a custom strategy.
   *
   * @example
   * import Anthropic from '@anthropic-ai/sdk';
   * import { AnthropicCountTokensEstimator } from '@agentplace/agent';
   *
   * new ContextBudgetGuardMiddleware({
   *   maxTokens: 200_000,
   *   estimator: new AnthropicCountTokensEstimator({
   *     client: new Anthropic({ apiKey }).messages,
   *   }),
   * })
   */
  estimator?: TokenEstimator;
};

/**
 * Simple budget guard that prevents oversized prompts from reaching the LLM API.
 *
 * Must be placed AFTER CompactionMiddleware (so tools are already
 * truncated) and AFTER CacheStrategyMiddleware (so cache points are set).
 *
 * Middleware order:
 *   1. CompactionMiddleware             — truncates tool results + collapses old messages
 *   2. CacheStrategyMiddleware          — places cache breakpoints
 *   3. ContextBudgetGuardMiddleware     — throws "too long" if still over budget ← this
 *
 * On throw, the agent loop catches the error, bumps escalation, and retries.
 * On retry, CompactionMiddleware runs with higher escalation
 * (more aggressive tool truncation + collapse with a halved keep window).
 */
export class ContextBudgetGuardMiddleware implements KernelModelMiddleware {
  private readonly maxTokens: number;
  private readonly model?: string;
  private readonly estimator?: TokenEstimator;

  constructor(options: ContextBudgetGuardOptions) {
    this.maxTokens = options.maxTokens;
    this.model = options.model;
    this.estimator = options.estimator;
  }

  create(ctx: KernelModelMiddlewareContext): LanguageModelMiddleware {
    const { maxTokens, model, estimator } = this;

    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        const opts = params as LanguageModelV3CallOptions;

        const result = estimator
          ? await estimator.estimate(
              opts,
              ctx.state.getModelId() ?? undefined,
              ctx.state.getProvider() ?? undefined,
            )
          : estimateTokensDetailed(opts.prompt, model);

        const { tokens: estimated, estimator: estimatorName, charsPerToken } = result;
        const responseId = ctx.state.getResponseId?.();
        const appState = ctx.state.getApp<Record<string, unknown>>();
        const metadata = appState?.metadata as Record<string, unknown> | undefined;

        logger.info('[ContextBudgetGuard] Estimated prompt tokens', {
          estimatedTokens: estimated,
          maxTokens,
          estimator: estimatorName,
          charsPerToken,
          model: ctx.state.getModelId() ?? model ?? 'unknown',
          messageCount: opts.prompt.length,
          withinBudget: estimated <= maxTokens,
          responseId,
          configId: metadata?.configId,
        });

        if (estimated > maxTokens) {
          const detail =
            charsPerToken != null ? `${estimatorName}@${charsPerToken}` : estimatorName;
          throw new Error(
            `Prompt too long: estimated ${estimated} tokens (${detail}) exceeds budget of ${maxTokens} tokens`,
          );
        }

        return opts;
      },
    };
  }
}
