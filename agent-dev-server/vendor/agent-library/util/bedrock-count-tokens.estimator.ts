/**
 * Exact token estimator using Amazon Bedrock's CountTokens API.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html
 */

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { getAgentLogger } from '../types/logger.ts';
import { HeuristicTokenEstimator, type TokenEstimator } from './token-estimator.ts';
import { buildBedrockCountTokensParams } from './bedrock-prompt-converter.ts';
import type { TokenEstimationResult } from './token-estimation.ts';

// =============================================================================
// Client interface (duck-typed)
// =============================================================================

/**
 * Duck-typed interface for Bedrock Runtime token counting.
 * AWS SDK v3 generates convenience methods on the client.
 *
 * @example
 * import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
 * const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
 * new BedrockCountTokensEstimator({ client: bedrock });
 */
export interface BedrockRuntimeCountTokensClient {
  countTokens(params: {
    modelId: string;
    messages: unknown[];
    system?: unknown[];
    toolConfig?: unknown;
  }): Promise<{ inputTokens: number }>;
}

export type BedrockCountTokensEstimatorOptions = {
  client: BedrockRuntimeCountTokensClient;
  fallback?: TokenEstimator;
};

// =============================================================================
// BedrockCountTokensEstimator
// =============================================================================

export class BedrockCountTokensEstimator implements TokenEstimator {
  private readonly client: BedrockRuntimeCountTokensClient;
  private readonly fallback: TokenEstimator;
  private readonly cache = new WeakMap<LanguageModelV3Prompt, Promise<TokenEstimationResult>>();

  constructor(options: BedrockCountTokensEstimatorOptions) {
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

    if (!isBedrockProvider(provider)) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    if (!modelId) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    const params = buildBedrockCountTokensParams(opts.prompt, opts.tools, modelId);
    if (!params) {
      return this.fallback.estimate(opts, modelId, provider);
    }

    try {
      const result = await this.client.countTokens(params);
      return {
        tokens: result.inputTokens,
        estimator: 'bedrock-count-tokens',
      };
    } catch (err) {
      logger.warn('[BedrockCountTokensEstimator] countTokens failed, using fallback', {
        model: modelId,
        error: String(err),
        messageCount: opts.prompt.length,
      });
      return this.fallback.estimate(opts, modelId, provider);
    }
  }
}

// =============================================================================
// Provider check (private)
// =============================================================================

function isBedrockProvider(provider: string | undefined): boolean {
  return provider?.startsWith('amazon-bedrock') === true;
}
