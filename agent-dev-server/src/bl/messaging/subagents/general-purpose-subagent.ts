import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { IToolRegistry, SubagentConfig } from '../../agent/agent-library.ts';
import { inheritToolsFromParent } from './registry-helpers.ts';
import { GENERAL_PURPOSE_SYSTEM_PROMPT } from './general-purpose-prompt.ts';

const MAX_MODEL_CALLS = 30;

const EXCLUDED_PARENT_TOOLS = ['playVoiceAssistance', 'persistToMemoryBank', 'useAgent'];

export function createGeneralPurposeSubagent(args: {
  parentRegistry: IToolRegistry;
  /** Resolved SUBAGENT_DEFAULT_MODEL, or the agent's own model as a fallback. */
  defaultModel: LanguageModelV3;
  /** False when no model resolver is available — the tool then exposes no model param. */
  modelSelectable: boolean;
  agentId?: string;
}): SubagentConfig {
  const modelSentence = args.modelSelectable
    ? " Runs on 'gemini-flash' by default; pass model to pick another when the task needs more depth."
    : '';
  return {
    type: 'general-purpose',
    description:
      'General-purpose subagent for researching complex questions, multi-step tasks, or code/context searches that would use too much parent context. Returns a single final answer. ' +
      'Can read files from agent storage — if the task is long or structured (e.g. a technical spec), write it to storage first and pass the path in `task` instead of inlining the whole text. The subagent reads/lists only; it cannot write back.' +
      modelSentence,
    systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
    toolRegistry: inheritToolsFromParent(args.parentRegistry, {
      excludeNames: EXCLUDED_PARENT_TOOLS,
    }),
    model: args.defaultModel,
    maxModelCalls: MAX_MODEL_CALLS,
    // Whitelist excludes 'code-executor-sonnet' so the parent cannot route
    // general-purpose work onto direct-Anthropic Sonnet (paid). The parent
    // sees the option in the shared SUBAGENT_ALLOWED_MODELS enum, but the
    // strict gate in `SubagentToolModel.execute` rejects it for this subagent.
    allowedModelOverrides: [
      'sonnet',
      'opus',
      'gemini-pro',
      'gemini-flash',
      'gemini-flash-lite',
      'gpt-5-5',
    ],
    traceName: `GeneralPurpose: ${args.agentId ?? 'unknown'}`,
  };
}
