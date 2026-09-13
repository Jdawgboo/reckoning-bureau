import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { IToolRegistry, SubagentConfig } from '../../agent/agent-library';
import type { ModelProvider } from '../../agent/interfaces';
import type { AgentStorageFactoryService } from '../../../services/agent-storage-factory.service';
import { createGeneralPurposeSubagent } from './general-purpose-subagent.ts';
import { createCodeExecutorSubagent } from './code-executor-subagent.ts';
import { createPageFetcherSubagent } from './page-fetcher-subagent.ts';
import { createRespondentCounselSubagent } from './respondent-counsel-subagent.ts';
import { SUBAGENT_DEFAULT_MODEL, type SubagentModelResolver } from './subagent-model-resolver.ts';

/**
 * Registry of subagents available to the default agent.
 *
 * To add a new subagent:
 *   1. Create `./<name>-subagent.ts` that exports
 *      `create<Name>Subagent(args): SubagentConfig` — use
 *      `general-purpose-subagent.ts` as the template.
 *   2. Add the function call to the array returned below.
 *
 * SubagentConfig fields (see `SubagentConfig` in @agentplace/agent):
 *   - `type`: unique short id used in the Subagent tool's `subagent` param
 *   - `description`: shown to the parent LLM so it picks the right subagent
 *   - `systemPrompt`: defines the subagent's behaviour
 *   - `toolRegistry`: tools available to the subagent — three patterns:
 *       (A) `inheritToolsFromParent(parent)` — parent minus UI/Subagent
 *       (B) `inheritToolsFromParent(parent, { includeOnlyNames: [...] })`
 *           for a whitelist, or `{ excludeNames: [...] }` to drop a few
 *       (C) `new ToolRegistry([new MyTool(), ...])` — a fully custom set
 *   - `model`: LanguageModelV3 used when the tool schema exposes no `model`
 *     param; with a resolver wired the schema's SUBAGENT_DEFAULT_MODEL wins
 *   - `maxModelCalls`: runaway guard (30 is a reasonable default)
 *   - `traceName`: optional Langfuse trace label — use `<Name>: ${agentId}`
 *     so traces are grouped by subagent kind and agent in the dashboard
 */
export async function createAgentSubagents(args: {
  parentRegistry: IToolRegistry;
  defaultModel: LanguageModelV3;
  /** Built once by the caller; null when the resolver build failed. */
  modelResolver: SubagentModelResolver | null;
  /** Used only for the page-fetcher's Vertex provider. */
  modelProvider: ModelProvider;
  storageFactory: AgentStorageFactoryService;
  /** Already includes `/api/gateway` prefix. */
  gatewayBaseUrl: string;
  accessKey: string;
  agentId?: string;
}): Promise<SubagentConfig[]> {
  const resolver = args.modelResolver;

  // general-purpose always ships, so resolving its model must not be able to
  // take the whole registry down — fall back to the agent's own model.
  let platformDefault: ReturnType<SubagentModelResolver> | undefined;
  try {
    platformDefault = resolver?.(SUBAGENT_DEFAULT_MODEL);
  } catch (error) {
    console.warn('[createAgentSubagents] failed to resolve the default subagent model:', error);
  }
  const subagents: SubagentConfig[] = [
    createGeneralPurposeSubagent({
      parentRegistry: args.parentRegistry,
      defaultModel: platformDefault?.model ?? args.defaultModel,
      modelSelectable: Boolean(resolver),
      agentId: args.agentId,
    }),
    // The evidence-only counsel is always available: it has no tools or optional provider dependency.
    createRespondentCounselSubagent({
      defaultModel: platformDefault?.model ?? args.defaultModel,
      agentId: args.agentId,
    }),
  ];

  // Optional subagents run on resolved models. Without a resolver they're
  // skipped and the default agent still ships with general-purpose.
  if (!resolver) {
    console.warn('[createAgentSubagents] no model resolver available; skipping optional subagents');
    return subagents;
  }

  // code-executor — best-effort: a failure here must not drop the others.
  try {
    const codeExec = resolver('code-executor-sonnet');
    if (codeExec) {
      subagents.push(
        createCodeExecutorSubagent({
          directAnthropicSonnet: codeExec.model,
          modelSettings: codeExec.modelSettings,
          uploadConfig: {
            storageFactory: args.storageFactory,
            gatewayBaseUrl: args.gatewayBaseUrl,
            accessKey: args.accessKey,
          },
          parentRegistry: args.parentRegistry,
          agentId: args.agentId,
        }),
      );
    }
  } catch (error) {
    console.warn('[createAgentSubagents] failed to build code-executor subagent; skipping:', error);
  }

  // page-fetcher — best-effort: needs Vertex creds; without them it drops out
  // and callers fall back to web_search.
  try {
    const flashLite = resolver('gemini-flash-lite');
    const vertex = args.modelProvider.getVertexProvider?.();
    // Narrow both nullable values before use: `flashLite` is `ResolverResult | null`,
    // `vertex` is undefined when the ModelProvider has no `getVertexProvider`.
    if (flashLite && vertex) {
      subagents.push(
        createPageFetcherSubagent({
          geminiFlashLite: flashLite.model,
          modelSettings: flashLite.modelSettings,
          vertex,
          agentId: args.agentId,
        }),
      );
    } else {
      console.warn(
        '[createAgentSubagents] Vertex provider not available; skipping page-fetcher subagent',
      );
    }
  } catch (error) {
    console.warn('[createAgentSubagents] failed to build page-fetcher subagent; skipping:', error);
  }

  return subagents;
}
