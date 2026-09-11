import type { JSONObject, LanguageModelV3 } from '@ai-sdk/provider';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { ModelProvider } from '../../agent/interfaces';

/**
 * Per-model configuration for the subagent.
 *
 * This file is the single source of truth for EVERY model-specific setting
 * the subagent uses — ID, reasoning/thinking config, maxOutputTokens, and
 * any future per-model tuning. When a model is renamed or retired, update
 * the ID and any settings here, then redeploy the agent.
 *
 * Two providers are mixed: Bedrock for the Claude models and Google Vertex
 * for Gemini. `detectProvider` in `../agent/model-provider.service.ts` picks
 * the right AI SDK provider based on the model-ID prefix.
 */
type ShortName =
  | 'sonnet'
  | 'opus'
  | 'gemini-pro'
  | 'gemini-flash'
  | 'gemini-flash-lite'
  | 'gpt-5-5'
  | 'code-executor-sonnet';

type ModelConfig = {
  modelId: string;
  maxOutputTokens: number;
  providerOptions: ProviderOptions;
};

const MODEL_CONFIG: Record<ShortName, ModelConfig> = {
  sonnet: {
    modelId: 'global.anthropic.claude-sonnet-5',
    maxOutputTokens: 10_000,
    providerOptions: {
      bedrock: {
        reasoningConfig: { type: 'adaptive', maxReasoningEffort: 'medium' },
      } as JSONObject,
    },
  },
  opus: {
    modelId: 'global.anthropic.claude-opus-5',
    maxOutputTokens: 20_000,
    providerOptions: {
      bedrock: {
        reasoningConfig: { type: 'adaptive', maxReasoningEffort: 'high', display: 'summarized' },
      } as JSONObject,
    },
  },
  'gemini-pro': {
    modelId: 'gemini-3.1-pro-preview',
    maxOutputTokens: 20_000,
    providerOptions: {
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
      } as JSONObject,
    },
  },
  'gemini-flash': {
    modelId: 'gemini-3.7-flash',
    maxOutputTokens: 20_000,
    providerOptions: {
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
      } as JSONObject,
    },
  },
  'gemini-flash-lite': {
    modelId: 'gemini-3.5-flash-lite',
    maxOutputTokens: 20_000,
    providerOptions: {
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
      } as JSONObject,
    },
  },
  'gpt-5-5': {
    modelId: 'gpt-5.5',
    maxOutputTokens: 20_000,
    providerOptions: {
      openai: {
        reasoningSummary: 'auto',
        reasoningEffort: 'medium',
      } as JSONObject,
    },
  },
  'code-executor-sonnet': {
    // No `global.anthropic.` prefix → routed to direct Anthropic provider, not Bedrock.
    // Required because Code Execution is only available on the direct Claude API.
    modelId: 'claude-sonnet-5',
    // 8K was too tight: generating Python for a multi-slide presentation routinely
    // overshoots, AI SDK then auto-continues with `finishReason: 'length'`, and the
    // continuation request loses the parent `tool_use` block for the half-streamed
    // `code_execution` → Anthropic 400s with `unexpected tool_use_id in tool_result`.
    // 20K matches the other paid models in this config and gives the model enough
    // room to finish the assistant turn in one shot.
    maxOutputTokens: 20_000,
    providerOptions: {
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'low',
        container: {
          skills: [
            { type: 'anthropic', skillId: 'pdf', version: 'latest' },
            { type: 'anthropic', skillId: 'pptx', version: 'latest' },
            { type: 'anthropic', skillId: 'xlsx', version: 'latest' },
            { type: 'anthropic', skillId: 'docx', version: 'latest' },
          ],
        },
      } as JSONObject,
    },
  },
};

export const SUBAGENT_ALLOWED_MODELS = [
  'sonnet',
  'opus',
  'gemini-pro',
  'gemini-flash',
  'gemini-flash-lite',
  'gpt-5-5',
  'code-executor-sonnet',
] as const;

/**
 * What a subagent runs on when the agent doesn't pick a model. Feeds both the
 * tool schema's default and general-purpose's fallback model, so they can't drift.
 */
export const SUBAGENT_DEFAULT_MODEL: ShortName = 'gemini-flash';

export const SUBAGENT_MODEL_DESCRIPTION = `Which model runs the subagent. Default: gemini-flash.
- "sonnet": Claude Sonnet 5 — general-purpose work: research, data processing, everyday multi-step tasks.
- "opus": Claude Opus 5 — highest-quality complex work: hard multi-step reasoning, synthesis, long chains of logic.
- "gemini-pro": Gemini 3.1 Pro — research and general work with stronger context handling than flash-lite.
- "gemini-flash": Gemini 3.6 Flash — the default: general-purpose work at low cost and latency.
- "gemini-flash-lite": Gemini 3.5 Flash Lite — fast and cheap: quick lookups, bulk processing, or tasks where latency matters more than depth.
- "gpt-5-5": GPT-5.5 — math, logic, structured reasoning, and problems that benefit from rigorous step-by-step analysis.
- "code-executor-sonnet": Direct-Anthropic Claude Sonnet 5 with Code Execution + PDF/PPTX skills. ONLY valid for the 'code-executor' subagent.`;

type ResolverResult = {
  model: LanguageModelV3;
  modelSettings: {
    maxOutputTokens: number;
    providerOptions: ProviderOptions;
  };
};

/** Resolves a subagent short-name to its model + settings, or null if unknown. */
export type SubagentModelResolver = (shortName: string) => ResolverResult | null;

/**
 * Builds the subagent model resolver for the default agent. Pre-caches
 * every model in `MODEL_CONFIG` so subsequent tool calls are cache hits.
 */
export async function buildSubagentModelResolver(
  modelProvider: ModelProvider,
): Promise<SubagentModelResolver> {
  const cache = new Map<ShortName, ResolverResult>();
  for (const [short, cfg] of Object.entries(MODEL_CONFIG) as [ShortName, ModelConfig][]) {
    const model = await modelProvider.getModel(cfg.modelId);
    cache.set(short, {
      model,
      modelSettings: {
        maxOutputTokens: cfg.maxOutputTokens,
        providerOptions: cfg.providerOptions,
      },
    });
  }
  return (shortName) => cache.get(shortName as ShortName) ?? null;
}
