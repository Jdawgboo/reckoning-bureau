import type { LanguageModelV3 } from '@ai-sdk/provider';
import { ToolRegistry, type SubagentConfig } from '../../agent/agent-library.ts';
import { RESPONDENT_COUNSEL_SYSTEM_PROMPT } from './respondent-counsel-prompt.ts';

/**
 * Deliberately headless: this counsel receives a narrow packet in its task and
 * cannot read storage, files, records, the web, or any parent-agent tools.
 */
export function createRespondentCounselSubagent(args: {
  defaultModel: LanguageModelV3;
  agentId?: string;
}): SubagentConfig {
  return {
    type: 'respondent-counsel',
    description:
      'Runs a controlled evidence-only opposition hearing after the visitor presses Face the Opposition. ' +
      'Pass only the CaseFile action’s hearing packet, hearing transcript, current answer, and phase; it has no tools and must never receive assessments, scores, settlement data, or red-team notes.',
    systemPrompt: RESPONDENT_COUNSEL_SYSTEM_PROMPT,
    toolRegistry: new ToolRegistry(),
    model: args.defaultModel,
    maxModelCalls: 1,
    allowedModelOverrides: ['gpt-5-5'],
    traceName: `RespondentCounsel: ${args.agentId ?? 'unknown'}`,
  };
}
