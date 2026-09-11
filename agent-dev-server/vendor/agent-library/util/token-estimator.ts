/**
 * Pluggable token estimation for ContextBudgetGuardMiddleware.
 *
 * The `TokenEstimator` interface decouples the budget guard from a specific
 * estimation strategy. Built-in implementations:
 *
 * - `HeuristicTokenEstimator` — fast, zero-latency, approximate (chars ÷ ratio)
 * - `AnthropicCountTokensEstimator` — exact, uses Anthropic's count_tokens API
 *
 * Custom estimators can be passed to ContextBudgetGuardMiddleware.
 *
 * @see ContextBudgetGuardMiddleware
 * @see AnthropicCountTokensEstimator
 */

import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { estimatePromptTokensDetailed, type TokenEstimationResult } from './token-estimation.ts';

export type { TokenEstimationResult };

// =============================================================================
// Interface
// =============================================================================

export interface TokenEstimator {
  estimate(
    opts: LanguageModelV3CallOptions,
    modelId: string | undefined,
    provider: string | undefined,
  ): Promise<TokenEstimationResult>;
}

// =============================================================================
// HeuristicTokenEstimator
// =============================================================================

/**
 * Async wrapper around the existing char-per-token heuristic.
 * Zero latency, no external calls, conservative overestimate.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  async estimate(
    opts: LanguageModelV3CallOptions,
    modelId: string | undefined,
    _provider: string | undefined,
  ): Promise<TokenEstimationResult> {
    return estimatePromptTokensDetailed(opts.prompt, modelId);
  }
}
