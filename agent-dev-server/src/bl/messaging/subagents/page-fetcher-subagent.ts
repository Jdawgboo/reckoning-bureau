import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { SubagentConfig } from '../../agent/agent-library.ts';
import { ToolRegistry } from '../../tools/tool.registry.ts';
import { VertexUrlContextTool } from '../../tools/impl/vertex-url-context.tool.ts';
import { PAGE_FETCHER_SYSTEM_PROMPT } from './page-fetcher-prompt.ts';

// Happy path is one call; ceiling protects against multi-step reasoning/retry.
const MAX_MODEL_CALLS = 5;
const FIXED_MODEL_SHORT_NAME = 'gemini-flash-lite';

export function createPageFetcherSubagent(args: {
  /** Resolved Vertex Gemini Flash Lite model. */
  geminiFlashLite: LanguageModelV3;
  /** Provider options from MODEL_CONFIG['gemini-flash-lite']. */
  modelSettings: { maxOutputTokens: number; providerOptions: ProviderOptions };
  /** Injected (not module-level) so tests don't need real Vertex creds. */
  vertex: GoogleVertexProvider;
  agentId?: string;
}): SubagentConfig {
  return {
    type: 'page-fetcher',
    description:
      'Fetch the full cleaned text of one to three web pages and return it verbatim as markdown. ' +
      "Use when the user gives a specific URL or when web_search's synthesis isn't enough and you " +
      'need the article body to reason on. Static HTML only — JS-rendered SPAs (X.com timelines, ' +
      "dynamic comment threads) may come back partial. For PDFs use the `filesystem` tool's `view` " +
      'command instead — that includes any URL whose body is a PDF, e.g. ' +
      '`https://arxiv.org/pdf/2401.12345` or `https://example.com/whitepaper.pdf`. ' +
      `Pass the URL(s) in \`task\` as a plain list or short instruction and model: '${FIXED_MODEL_SHORT_NAME}' ` +
      `(this is the only model accepted — other values are rejected). The subagent returns one ` +
      'markdown document per URL with the URL as a header.',
    systemPrompt: PAGE_FETCHER_SYSTEM_PROMPT,
    toolRegistry: new ToolRegistry([new VertexUrlContextTool({ provider: args.vertex })]),
    model: args.geminiFlashLite,
    maxModelCalls: MAX_MODEL_CALLS,
    modelSettings: args.modelSettings,
    // Single-name whitelist pins the model — the override gate in
    // SubagentToolModel.execute rejects anything else.
    allowedModelOverrides: [FIXED_MODEL_SHORT_NAME],
    traceName: `PageFetcher: ${args.agentId ?? 'unknown'}`,
  };
}
