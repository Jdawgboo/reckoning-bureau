/**
 * Exact token estimator using Gemini's countTokens API.
 *
 * @see https://ai.google.dev/gemini-api/docs/tokens
 */

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { getAgentLogger } from '../types/logger.ts';
import { HeuristicTokenEstimator, type TokenEstimator } from './token-estimator.ts';
import { buildGeminiCountTokensParams } from './gemini-prompt-converter.ts';
import type { TokenEstimationResult } from './token-estimation.ts';

// =============================================================================
// Client interface (duck-typed)
// =============================================================================

/**
 * Duck-typed interface for Gemini token counting.
 * Gemini SDKs scope countTokens to a model instance, so consumers
 * construct this adapter from their model object.
 *
 * @example
 * import { GoogleGenerativeAI } from '@google/generative-ai';
 * const genAI = new GoogleGenerativeAI(apiKey);
 * const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
 * new GeminiCountTokensEstimator({
 *   client: { countTokens: (params) => model.countTokens(params) },
 * });
 */
export interface GeminiModelsClient {
  countTokens(params: {
    contents: unknown[];
    systemInstruction?: unknown;
    tools?: unknown[];
  }): Promise<{ totalTokens: number }>;
}

export type GeminiCountTokensEstimatorOptions = {
  client: GeminiModelsClient;
  fallback?: TokenEstimator;
};

// =============================================================================
// GeminiCountTokensEstimator
// =============================================================================

export class GeminiCountTokensEstimator implements TokenEstimator {
  private readonly client: GeminiModelsClient;
  private readonly fallback: TokenEstimator;
  private readonly cache = new WeakMap<LanguageModelV3Prompt, Promise<TokenEstimationResult>>();

  constructor(options: GeminiCountTokensEstimatorOptions) {
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

    if (!isGeminiProvider(modelId, provider)) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    const params = buildGeminiCountTokensParams(opts.prompt, opts.tools);
    if (!params) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    try {
      const result = await this.client.countTokens(params);
      return {
        tokens: result.totalTokens,
        estimator: 'gemini-count-tokens',
      };
    } catch (err) {
      logger.warn('[GeminiCountTokensEstimator] countTokens failed, using fallback', {
        model: modelId,
        error: String(err),
        messageCount: opts.prompt.length,
      });
      return this.fallback.estimate(opts, modelId, provider);
    }
  }
}

// =============================================================================
// Model ID resolution (private)
// =============================================================================

function isGeminiProvider(modelId: string | undefined, provider: string | undefined): boolean {
  if (!modelId || !provider) return false;

  // Google Vertex AI or Google AI
  if (provider.startsWith('google')) {
    return modelId.toLowerCase().includes('gemini');
  }

  return false;
}
