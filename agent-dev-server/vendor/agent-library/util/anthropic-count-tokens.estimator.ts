/**
 * Exact token estimator using Anthropic's count_tokens API.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/token-counting
 */

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { getAgentLogger } from '../types/logger.ts';
import { isRecord } from './type-guards.ts';
import { HeuristicTokenEstimator, type TokenEstimator } from './token-estimator.ts';
import { buildCountTokensParams } from './anthropic-prompt-converter.ts';
import type { TokenEstimationResult } from './token-estimation.ts';

// =============================================================================
// Client interface (duck-typed)
// =============================================================================

/**
 * Duck-typed interface matching @anthropic-ai/sdk's `client.messages`.
 * Accepts the real SDK client.messages without agent-library importing the package.
 *
 * @example
 * import Anthropic from '@anthropic-ai/sdk';
 * const client = new Anthropic({ apiKey }).messages;
 */
export interface AnthropicMessagesClient {
  countTokens(params: {
    model: string;
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    system?: string;
    tools?: unknown[];
    thinking?: { type: 'enabled'; budget_tokens: number };
  }): Promise<{ input_tokens: number }>;
}

export type AnthropicCountTokensEstimatorOptions = {
  /** Pass `new Anthropic({ apiKey }).messages` from @anthropic-ai/sdk */
  client: AnthropicMessagesClient;
  /** Fallback estimator when the API call fails. Defaults to HeuristicTokenEstimator. */
  fallback?: TokenEstimator;
};

// =============================================================================
// AnthropicCountTokensEstimator
// =============================================================================

/**
 * Exact token estimator using Anthropic's count_tokens API.
 *
 * - Exact counting for text, tool calls, tool results, images, PDFs (Anthropic-supported types)
 * - Unsupported content types (e.g. provider file IDs, custom parts) are skipped — may undercount
 * - Falls back to HeuristicTokenEstimator for non-Anthropic models or on API error
 * - Latency depends on Anthropic SDK client configuration (typically 100–500ms network round-trip)
 * - Results are cached by prompt array reference — share one instance across middlewares to avoid
 *   redundant API calls when the prompt is unchanged between middleware steps
 *
 * @example
 * import Anthropic from '@anthropic-ai/sdk';
 * import { AnthropicCountTokensEstimator, ContextBudgetGuardMiddleware } from '@agentplace/agent';
 *
 * const estimator = new AnthropicCountTokensEstimator({
 *   client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages,
 * });
 *
 * new CompactionMiddleware({ triggerTokens: 150_000, estimator })
 * new ContextBudgetGuardMiddleware({ maxTokens: 200_000, estimator })
 */
export class AnthropicCountTokensEstimator implements TokenEstimator {
  private readonly client: AnthropicMessagesClient;
  private readonly fallback: TokenEstimator;
  private readonly cache = new WeakMap<LanguageModelV3Prompt, Promise<TokenEstimationResult>>();

  constructor(options: AnthropicCountTokensEstimatorOptions) {
    this.client = options.client;
    this.fallback = options.fallback ?? new HeuristicTokenEstimator();
  }

  async estimate(
    opts: LanguageModelV3CallOptions,
    modelId: string | undefined,
    provider: string | undefined,
  ): Promise<TokenEstimationResult> {
    const cached = this.cache.get(opts.prompt);
    if (cached) return cached;

    const promise = this.doEstimate(opts, modelId, provider);
    this.cache.set(opts.prompt, promise);
    return promise;
  }

  private async doEstimate(
    opts: LanguageModelV3CallOptions,
    modelId: string | undefined,
    provider: string | undefined,
  ): Promise<TokenEstimationResult> {
    const logger = getAgentLogger();

    const anthropicModelId = resolveAnthropicModelId(modelId, provider);
    if (!anthropicModelId) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    const params = buildCountTokensParams(opts.prompt, opts.tools, anthropicModelId);
    if (!params) {
      // Only system messages — empty messages array; skip API call
      return this.fallback.estimate(opts, modelId, provider);
    }

    try {
      const result = await this.client.countTokens(params);
      return {
        tokens: result.input_tokens,
        estimator: 'anthropic-count-tokens',
      };
    } catch (err) {
      const status = isRecord(err) && typeof err.status === 'number' ? err.status : null;
      const detail = {
        model: anthropicModelId,
        error: String(err),
        status,
        messageCount: opts.prompt.length,
      };
      // A 400 means the API rejected the prompt structure — the same prompt is
      // about to be sent to the model, so surface it loudly.
      if (status === 400) {
        logger.error(
          '[AnthropicCountTokensEstimator] countTokens rejected prompt (400), using fallback',
          detail,
        );
      } else {
        logger.warn('[AnthropicCountTokensEstimator] countTokens failed, using fallback', detail);
      }
      return this.fallback.estimate(opts, modelId, provider);
    }
  }
}

// =============================================================================
// Model ID normalization (private)
// =============================================================================

/**
 * Maps an AI SDK provider + modelId pair to a clean Anthropic model ID.
 * Returns undefined for non-Anthropic models (triggers heuristic fallback).
 *
 * Provider values (confirmed from BedrockCacheStrategy):
 * - Direct Anthropic: 'anthropic'
 * - Amazon Bedrock:   'amazon-bedrock'
 * - OpenRouter:       'openrouter'
 */
function resolveAnthropicModelId(
  modelId: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!modelId || !provider) return undefined;

  // Direct Anthropic: modelId is already the clean model name
  if (provider.startsWith('anthropic')) {
    return modelId;
  }

  // Amazon Bedrock: e.g. 'global.anthropic.claude-sonnet-4-6' → 'claude-sonnet-4-6'
  // Also handles version suffix: 'anthropic.claude-3-5-sonnet-20241022-v2:0' → 'claude-3-5-sonnet-20241022-v2'
  if (provider.startsWith('amazon-bedrock')) {
    const last = modelId.split('.').at(-1);
    if (last?.toLowerCase().includes('claude')) {
      return last.split(':')[0]; // strip Bedrock version suffix (':0', ':1', etc.)
    }
    return undefined;
  }

  // OpenRouter: e.g. 'anthropic/claude-opus-4' or 'anthropic/claude-opus-4:beta'
  if (provider.startsWith('openrouter')) {
    if (modelId.toLowerCase().startsWith('anthropic/')) {
      return modelId.slice('anthropic/'.length).split(':')[0];
    }
    return undefined;
  }

  return undefined;
}
