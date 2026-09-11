/**
 * Provider-aware token estimator selection for deployed agents.
 *
 * Exact count-tokens APIs are reached through the platform gateway (a
 * transparent per-provider proxy that injects provider auth); clients are
 * thin fetch wrappers matching agent-library's duck-typed interfaces.
 * Every count estimator falls back to the heuristic on API error, and this
 * factory never throws — worst case is heuristic estimation (legacy behavior).
 */
import { detectProvider } from '../agent/model-provider.service.ts';
import {
  AnthropicCountTokensEstimator,
  type AnthropicMessagesClient,
} from '../../../vendor/agent-library/util/anthropic-count-tokens.estimator.ts';
import {
  GeminiCountTokensEstimator,
  type GeminiModelsClient,
} from '../../../vendor/agent-library/util/gemini-count-tokens.estimator.ts';
import {
  OpenAICountTokensEstimator,
  type OpenAIResponsesClient,
} from '../../../vendor/agent-library/util/openai-count-tokens.estimator.ts';
import {
  HeuristicTokenEstimator,
  type TokenEstimator,
} from '../../../vendor/agent-library/util/token-estimator.ts';

export type TokenEstimatorConfig = {
  /** Gateway base URL including the /api/gateway prefix. */
  gatewayBaseUrl: string;
  accessKey: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
};

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  accessKey: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Access-Key': accessKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Include the body: provider error details (IAM action, invalid field)
    // live there, and the estimator's warn log is often the only evidence.
    const detail = await response.text().catch(() => '');
    throw new Error(`count-tokens request failed: ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

export function anthropicClient(
  gatewayBaseUrl: string,
  accessKey: string,
  fetchFn: typeof fetch = fetch,
): AnthropicMessagesClient {
  return {
    countTokens: async (params) => {
      const result = await postJson(
        fetchFn,
        `${gatewayBaseUrl}/anthropic/v1/messages/count_tokens`,
        accessKey,
        params,
      );
      return result as { input_tokens: number };
    },
  };
}

export function geminiClient(
  gatewayBaseUrl: string,
  accessKey: string,
  modelName: string,
  fetchFn: typeof fetch = fetch,
): GeminiModelsClient {
  return {
    countTokens: async (params) => {
      const result = await postJson(
        fetchFn,
        `${gatewayBaseUrl}/google-vertex/v1/publishers/google/models/${modelName}:countTokens`,
        accessKey,
        params,
      );
      return result as { totalTokens: number };
    },
  };
}

export function openaiClient(
  gatewayBaseUrl: string,
  accessKey: string,
  fetchFn: typeof fetch = fetch,
): OpenAIResponsesClient {
  return {
    inputTokens: {
      count: async (params) => {
        const result = await postJson(
          fetchFn,
          `${gatewayBaseUrl}/openai/v1/responses/input_tokens`,
          accessKey,
          params,
        );
        return result as { input_tokens: number };
      },
    },
  };
}

/**
 * detectProvider defaults unknown names to 'openai' — only genuinely OpenAI
 * models get the count estimator; everything else stays heuristic.
 */
function isOpenAiCountable(modelName: string): boolean {
  return modelName.startsWith('gpt') || modelName.startsWith('o3') || modelName.startsWith('o4');
}

/**
 * Bedrock-hosted Claude (`global.anthropic.*`) counts via Anthropic's
 * count_tokens endpoint, not Bedrock's CountTokens: Bedrock rejects some
 * Claude models ("The provided model doesn't support counting tokens", e.g.
 * claude-sonnet-5), while Anthropic's endpoint covers every Claude model with
 * the same tokenizer. The estimator maps `global.anthropic.*` ids to clean
 * Anthropic ids itself — same approach as the builder's shared estimator.
 */
export function createTokenEstimator(
  modelName: string,
  config: TokenEstimatorConfig,
): TokenEstimator {
  const { gatewayBaseUrl, accessKey } = config;
  const fetchFn = config.fetchFn ?? fetch;

  try {
    switch (detectProvider(modelName)) {
      case 'anthropic':
      case 'amazon-bedrock':
        return new AnthropicCountTokensEstimator({
          client: anthropicClient(gatewayBaseUrl, accessKey, fetchFn),
        });
      case 'google-vertex':
        return new GeminiCountTokensEstimator({
          client: geminiClient(gatewayBaseUrl, accessKey, modelName, fetchFn),
        });
      case 'openai':
        if (isOpenAiCountable(modelName)) {
          return new OpenAICountTokensEstimator({
            client: openaiClient(gatewayBaseUrl, accessKey, fetchFn),
          });
        }
        return new HeuristicTokenEstimator();
      default:
        return new HeuristicTokenEstimator();
    }
  } catch (error) {
    console.warn('[createTokenEstimator] falling back to heuristic:', error);
    return new HeuristicTokenEstimator();
  }
}
