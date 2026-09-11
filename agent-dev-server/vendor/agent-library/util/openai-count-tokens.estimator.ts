/**
 * Exact token estimator using OpenAI's Responses API input_tokens endpoint.
 *
 * @see https://platform.openai.com/docs/guides/token-counting
 */

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { getAgentLogger } from '../types/logger.ts';
import { HeuristicTokenEstimator, type TokenEstimator } from './token-estimator.ts';
import { buildOpenAIInputTokensParams } from './openai-prompt-converter.ts';
import type { TokenEstimationResult } from './token-estimation.ts';

// =============================================================================
// Client interface (duck-typed)
// =============================================================================

/**
 * Duck-typed interface matching OpenAI SDK's `client.responses`.
 *
 * @example
 * import OpenAI from 'openai';
 * const client = new OpenAI({ apiKey });
 * new OpenAICountTokensEstimator({ client: client.responses });
 */
export interface OpenAIResponsesClient {
  inputTokens: {
    count(params: {
      model: string;
      input: unknown[];
      tools?: unknown[];
    }): Promise<{ input_tokens: number }>;
  };
}

export type OpenAICountTokensEstimatorOptions = {
  /** Pass `new OpenAI({ apiKey }).responses` from the openai SDK */
  client: OpenAIResponsesClient;
  /** Fallback estimator when the API call fails. Defaults to HeuristicTokenEstimator. */
  fallback?: TokenEstimator;
};

// =============================================================================
// OpenAICountTokensEstimator
// =============================================================================

export class OpenAICountTokensEstimator implements TokenEstimator {
  private readonly client: OpenAIResponsesClient;
  private readonly fallback: TokenEstimator;
  private readonly cache = new WeakMap<LanguageModelV3Prompt, Promise<TokenEstimationResult>>();

  constructor(options: OpenAICountTokensEstimatorOptions) {
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

    const openaiModelId = resolveOpenAIModelId(modelId, provider);
    if (!openaiModelId) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    const params = buildOpenAIInputTokensParams(opts.prompt, opts.tools, openaiModelId);
    if (!params) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    try {
      const result = await this.client.inputTokens.count(params);
      return {
        tokens: result.input_tokens,
        estimator: 'openai-count-tokens',
      };
    } catch (err) {
      logger.warn('[OpenAICountTokensEstimator] inputTokens.count failed, using fallback', {
        model: openaiModelId,
        error: String(err),
        messageCount: opts.prompt.length,
      });
      return this.fallback.estimate(opts, modelId, provider);
    }
  }
}

// =============================================================================
// Model ID normalization (private)
// =============================================================================

/**
 * Maps an AI SDK provider + modelId pair to an OpenAI model ID.
 * Returns undefined for non-OpenAI models (triggers heuristic fallback).
 */
function resolveOpenAIModelId(
  modelId: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!modelId || !provider) return undefined;

  // Direct OpenAI or OpenAI-compatible
  if (provider.startsWith('openai')) {
    return modelId;
  }

  // OpenRouter: e.g. 'openai/gpt-4o' or 'openai/o3-mini'
  if (provider.startsWith('openrouter')) {
    if (modelId.toLowerCase().startsWith('openai/')) {
      return modelId.slice('openai/'.length).split(':')[0];
    }
    return undefined;
  }

  return undefined;
}
