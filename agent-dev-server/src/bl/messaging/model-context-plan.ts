/**
 * Platform policy: per-model context budgets for deployed agents.
 * Mirrors the builder's formula in
 * packages/server/src/bl/builder/builder-execution-plan.ts — keep the
 * constants in sync when the builder's policy changes. Deliberately NOT in
 * agent-library: the caps are AgentPlace product decisions, not generic
 * model facts.
 *
 * Matching is exact-name first, then longest prefix, then a conservative
 * fallback equal to the legacy hardcoded behavior (200k budget / 160k
 * trigger), so unknown models change nothing.
 */

export type ContextPlan = {
  /** Hard prompt budget enforced by ContextBudgetGuardMiddleware. */
  contextBudgetTokens: number;
  /** CompactionMiddleware activation threshold. */
  triggerTokens: number;
  /** Hot-zone budget kept after compaction. */
  keepRecentTokens: number;
};

type WindowPolicy = {
  contextWindowTokens: number;
  reserveTokens: number;
  triggerRatio: number;
};

const WINDOW_CAP_TOKENS = 350_000;
const TRIGGER_CAP_TOKENS = 200_000;
const KEEP_RECENT_TOKENS = 30_000;

const FALLBACK_POLICY: WindowPolicy = {
  contextWindowTokens: 200_000,
  reserveTokens: 40_000,
  triggerRatio: 0.8,
};

const ANTHROPIC_1M: WindowPolicy = {
  contextWindowTokens: 1_000_000,
  reserveTokens: 15_000,
  triggerRatio: 0.8,
};

const GEMINI_1M: WindowPolicy = {
  contextWindowTokens: 1_048_576,
  reserveTokens: 100_000,
  triggerRatio: 0.8,
};

const OPUS_4_5: WindowPolicy = {
  contextWindowTokens: 200_000,
  reserveTokens: 50_000,
  triggerRatio: 0.75,
};

const EXACT_POLICIES: Record<string, WindowPolicy> = {
  'claude-opus-4-5': OPUS_4_5,
  'global.anthropic.claude-opus-4-5-20251101-v1:0': OPUS_4_5,
};

/** Longest-prefix wins; keep more-specific prefixes above shorter ones. */
const PREFIX_POLICIES: ReadonlyArray<readonly [string, WindowPolicy]> = [
  ['global.anthropic.', ANTHROPIC_1M],
  ['claude-', ANTHROPIC_1M],
  ['google/gemini', GEMINI_1M],
  ['gemini-', GEMINI_1M],
  ['gpt-', { contextWindowTokens: 200_000, reserveTokens: 40_000, triggerRatio: 0.8 }],
  // Bedrock Mantle OpenAI models (openai.gpt-5.6-sol/terra/luna): 272k window
  // per the platform model registry.
  ['openai.gpt-', { contextWindowTokens: 272_000, reserveTokens: 40_000, triggerRatio: 0.8 }],
  ['grok-', { contextWindowTokens: 256_000, reserveTokens: 32_000, triggerRatio: 0.8 }],
];

export function resolveContextPlan(modelName: string): ContextPlan {
  const policy =
    EXACT_POLICIES[modelName] ??
    PREFIX_POLICIES.find(([prefix]) => modelName.startsWith(prefix))?.[1] ??
    FALLBACK_POLICY;

  const contextBudgetTokens = Math.min(policy.contextWindowTokens, WINDOW_CAP_TOKENS);
  const policyTrigger = Math.max(
    contextBudgetTokens - policy.reserveTokens,
    Math.floor(contextBudgetTokens * policy.triggerRatio),
  );

  return {
    contextBudgetTokens,
    triggerTokens: Math.min(TRIGGER_CAP_TOKENS, policyTrigger),
    keepRecentTokens: KEEP_RECENT_TOKENS,
  };
}
