import type { LanguageModelUsage } from 'ai';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { getPromptPressureTokens } from './token-usage.ts';
import { estimatePromptTokensDetailed, type TokenEstimationResult } from './token-estimation.ts';
import type { TokenEstimator } from './token-estimator.ts';

interface LastUsageSource {
  getLastUsage?(): LanguageModelUsage | null | undefined;
}

/**
 * Token estimator that returns the larger of the previous LLM call's reported
 * usage and the char-per-token heuristic over the current prompt.
 *
 * Usage alone is a trap after a compacted call: it describes the (small)
 * compacted prompt while the incoming prompt is the raw history again, so a
 * usage-only pressure skips compaction and the prompt oscillates between
 * compacted and raw shapes. The heuristic floor keeps pressure tracking what
 * is actually about to be sent, at the cost of a slightly early trigger.
 */
export class LastUsageTokenEstimator implements TokenEstimator {
  private readonly state: LastUsageSource;

  constructor(state: LastUsageSource) {
    this.state = state;
  }

  async estimate(
    opts: LanguageModelV3CallOptions,
    modelId: string | undefined,
    _provider: string | undefined,
  ): Promise<TokenEstimationResult> {
    const usage = this.state.getLastUsage?.();
    const usageTokens = getPromptPressureTokens(usage);
    const heuristic = estimatePromptTokensDetailed(opts.prompt, modelId);

    if (usageTokens != null && usageTokens > heuristic.tokens) {
      return { tokens: usageTokens, estimator: 'last-usage' };
    }
    return heuristic;
  }
}
