/**
 * ToolRegistryFactory
 *
 * Produces tools for dev-server agent runs. Two entry points:
 *
 *   - createPlatformTools(): dev-server-specific tools only (MCP, web search,
 *     NanoBanana, etc.). Wire this as `buildRuntimeTools` in createAgent() —
 *     built-ins are composed by agent-library.
 *
 *   - createToolRegistry(): full registry including agent-library built-ins.
 *     Used by MessagingService's chat path, which goes through
 *     agentFactory.create() directly and doesn't benefit from createAgent's
 *     runtime hook.
 */
import { ToolRegistry } from '../tools/tool.registry.ts';
import { PlayVoiceAssistanceTool } from '../tools/impl/assistant-voice.tool.ts';
import WebSearchToolModel from '../tools/impl/web-search-tool.model.ts';
import { WebSearchFallbackTool } from '../tools/impl/web-search-fallback.tool.ts';
import { XaiWebSearchTool } from '../tools/impl/xai-web-search.tool.ts';
import { XaiXSearchTool } from '../tools/impl/xai-x-search.tool.ts';
import { PersistToMemoryBankTool } from '../tools/impl/memory-bank.tool.ts';
import { ReportProgressTool } from '../tools/impl/report-progress.tool.ts';
import type { MCPServerRegistry } from '../tools/mcp-server.registry.ts';
import NanoBananaToolModel from '../tools/impl/nanobanana-tool.model.ts';
import { FirecrawlScrapeTool } from '../tools/impl/firecrawl-scrape.tool.ts';
import { FirecrawlSessionTool } from '../tools/impl/firecrawl-session.tool.ts';
import type { ModelProvider } from '../agent/interfaces.ts';
import { isUiMcpEnabled } from '../tools/mcp-config.ts';
import { FilesystemTool } from '../tools/impl/filesystem.tool.ts';
import { createSurfaceTools } from '../tools/impl/render-surface.tool.ts';
import { AGENT_CATALOG_ID, AGENT_SURFACE_CONTRACTS } from '../../surfaces/index.ts';
import { BUILTIN_CATALOG_ID, BUILTIN_SURFACE_CONTRACTS } from '../builtin-catalog/index.ts';
import { assembleSurfaceContracts } from '../builtin-catalog/assemble-surface-contracts.ts';
import type { SurfaceContractCatalog } from '../../ws/a2ui-click-resolver.ts';
import {
  type ComponentContract,
  type ContractProblem,
  validateContractShape,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { RecordsClient, type RecordsTransport } from '../records/records-client.ts';
import { resolveRecordsDeclarations } from '../records/records-declarations.resolver.ts';
import { createRecordsTools } from '../tools/impl/records.tool.ts';
import type { AgentStorageFactoryService } from '../../services/agent-storage-factory.service.ts';
import { PublicCdnUploadService } from '../../services/public-cdn-upload.service.ts';
import { UseAgentTool } from '../tools/impl/use-agent.tool.ts';
import {
  getBuiltInTools,
  filterScheduleSafeTools,
  createSubagentTool,
  GrepTool,
  type ToolModel,
  type AgentFactory,
  type StateTree,
} from '../agent/agent-library.ts';
import { getJWTPayload } from '../../util/jwt.ts';
import { DeepResearchToolModel } from '../tools/impl/deep-research-tool.model.ts';
import {
  SUBAGENT_ALLOWED_MODELS,
  SUBAGENT_DEFAULT_MODEL,
  SUBAGENT_MODEL_DESCRIPTION,
  buildSubagentModelResolver,
  type SubagentModelResolver,
} from './subagents/subagent-model-resolver.ts';
import { createAgentSubagents } from './subagents/subagent-factory.ts';
import { createContextManagement } from './context-management.config.ts';
import type { SurfaceSnapshot } from '../../types.ts';
import {
  DEFAULT_AGENT_RUN_PRESENTATION,
  type AgentRunPresentationCapability,
} from './agent-run-presentation.ts';
import { SetSessionLocaleTool } from '../tools/impl/set-session-locale.tool.ts';
import type { SessionLocaleRuntime } from './session-locale-runtime.ts';

/**
 * Compaction scope directories must be filesystem-safe. Case-PRESERVING:
 * Anthropic tool-call ids (toolu_...) are case-sensitive, so lowercasing
 * would merge distinct ids into one directory. Underscores stay (today's
 * tooluse_... ids pass through verbatim); anything else maps to '-'.
 */
function sanitizeCompactionScope(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * Per-turn facts the generated tools need, as one object rather than a growing
 * tail of positional booleans.
 */
export interface TurnToolContext {
  /** A live voice connection exists — grants the voice-only tools (report_progress). */
  voiceActive?: boolean;
  /** Trusted authority for context exposure and UI-capable tool grants. */
  runPresentation?: AgentRunPresentationCapability;
  /**
   * Structural state before a render first touches its target. Absent for
   * callers with no live screen source (HTTP, MCP, trigger, cron).
   */
  getSurfaceSnapshot?: (surfaceId: string) => SurfaceSnapshot;
  /** One durable locale authority for this conversation, when a session runtime is attached. */
  sessionLocale?: SessionLocaleRuntime;
}

export class ToolRegistryFactory {
  /**
   * This agent's render surfaces as `{component, purpose}` pairs, derived
   * from the same contract catalog the Render* tools use (agent zone
   * shadowing builtins — see `assembleSurfaceContracts`). This class is the
   * one sanctioned seam platform code may use to read `src/surfaces/`
   * (`zone-boundary.test.ts`), so callers outside `bl/` (e.g. the voice
   * gateway's grounding) go through here rather than importing the agent
   * anchor directly.
   */
  static getCapabilityCard(): Array<{ component: string; purpose: string }> {
    const surfaceSets = assembleSurfaceContracts(
      AGENT_SURFACE_CONTRACTS,
      BUILTIN_SURFACE_CONTRACTS,
    );
    return Object.values({
      ...surfaceSets.builtinContracts,
      ...surfaceSets.agentContracts,
    }).map((contract) => ({ component: contract.component, purpose: contract.purpose }));
  }

  /**
   * The same catalog keyed by the component name a rendered node carries, for
   * callers that need a contract back from a recorded surface. Goes through
   * this class for the seam reason above.
   */
  static getSurfaceContracts(): SurfaceContractCatalog {
    const surfaceSets = assembleSurfaceContracts(
      AGENT_SURFACE_CONTRACTS,
      BUILTIN_SURFACE_CONTRACTS,
    );
    const catalog: SurfaceContractCatalog = {};
    for (const contract of Object.values({
      ...surfaceSets.builtinContracts,
      ...surfaceSets.agentContracts,
    })) {
      catalog[contract.component] = contract;
    }
    return catalog;
  }

  /**
   * Shape problems in the contracts this agent would register, split by who can
   * fix them: `agent` is the builder's own `src/surfaces/`, `builtin` is ours.
   * Goes through this class for the seam reason above.
   */
  static getSurfaceContractProblems(): { agent: ContractProblem[]; builtin: ContractProblem[] } {
    const surfaceSets = assembleSurfaceContracts(
      AGENT_SURFACE_CONTRACTS,
      BUILTIN_SURFACE_CONTRACTS,
    );
    const collect = (contracts: Record<string, ComponentContract>): ContractProblem[] =>
      Object.values(contracts).flatMap((contract) => validateContractShape(contract));
    return {
      agent: collect(surfaceSets.agentContracts),
      builtin: collect(surfaceSets.builtinContracts),
    };
  }

  /**
   * Dev-server platform tools only — NO agent-library built-ins.
   *
   * Use as the `buildRuntimeTools` hook in createAgent(); built-ins
   * (getCurrentTime, schedule tools) are composed automatically by
   * createAgent itself, so including them here would produce duplicates.
   */
  static async createPlatformTools(
    modelName: string,
    modelProvider: ModelProvider,
    storageFactory: AgentStorageFactoryService,
    mcpRegistry: MCPServerRegistry,
    agentFactory?: AgentFactory,
    sessionKey?: string,
    stateTree?: StateTree | null,
    recordsTransport?: RecordsTransport | null,
    turnContext?: TurnToolContext,
  ): Promise<ToolModel[]> {
    const voiceActive = turnContext?.voiceActive ?? false;
    const getSurfaceSnapshot = turnContext?.getSurfaceSnapshot;
    const runPresentation = turnContext?.runPresentation ?? DEFAULT_AGENT_RUN_PRESENTATION;
    const tools: ToolModel[] = [];
    const add = (tool: ToolModel) => tools.push(tool);

    if (turnContext?.sessionLocale) {
      add(new SetSessionLocaleTool(turnContext.sessionLocale));
    }

    add(new FilesystemTool({ storageFactory, sessionKey }));
    add(
      new GrepTool({
        agentStorage: storageFactory.getStorage(sessionKey),
        description:
          'Search for text patterns across agent storage using regex (grep). ' +
          'Branches searched by default: source/ (project files), common/ (shared files), ' +
          'private/ (this session), tool-results/ (stored tool results). ' +
          'Use "path" to scope the search to a branch or subpath. ' +
          'Long lines are returned as a bounded excerpt, matches and context alike.',
      }),
    );
    if (runPresentation.uiEffects === 'allowed') {
      // Renderer-less channels may still emit markdown-backed surfaces. Only
      // the trusted UI-effects capability removes these tools altogether.
      const surfaceSets = assembleSurfaceContracts(
        AGENT_SURFACE_CONTRACTS,
        BUILTIN_SURFACE_CONTRACTS,
      );
      for (const tool of createSurfaceTools({
        contracts: surfaceSets.agentContracts,
        catalogId: AGENT_CATALOG_ID,
        stateTree,
        sessionKey,
        getSurfaceSnapshot,
        localization: turnContext?.sessionLocale,
      })) {
        add(tool);
      }
      for (const tool of createSurfaceTools({
        contracts: surfaceSets.builtinContracts,
        catalogId: BUILTIN_CATALOG_ID,
        stateTree,
        sessionKey,
        getSurfaceSnapshot,
        localization: turnContext?.sessionLocale,
      })) {
        add(tool);
      }
    }

    if (recordsTransport) {
      const records = new RecordsClient(recordsTransport, {
        ...(sessionKey !== undefined && { sessionId: sessionKey }),
      });
      for (const tool of createRecordsTools(records, await resolveRecordsDeclarations(records))) {
        add(tool);
      }
    }

    if (voiceActive) {
      // Someone is listening to this turn: the agent may say what it has done
      // so far. On a screen the same work is already visible as it happens.
      add(new ReportProgressTool());
    }

    if (isUiMcpEnabled() && runPresentation.uiEffects === 'allowed') {
      add(new PlayVoiceAssistanceTool());
      add(new PersistToMemoryBankTool());
    }

    if (modelName.startsWith('gpt') || modelName.startsWith('o3') || modelName.startsWith('o4')) {
      const openai = modelProvider.getOpenAIProvider?.();
      if (openai) {
        add(new WebSearchToolModel({ provider: openai }));
      }
    }
    if (
      modelName.startsWith('claude') ||
      modelName.startsWith('global.anthropic.') ||
      modelName.startsWith('openai.')
    ) {
      const vertex = modelProvider.getVertexProvider?.();
      if (vertex) {
        add(new WebSearchFallbackTool({ provider: vertex }));
      }
    }
    if (modelName.startsWith('gemini')) {
      const vertex = modelProvider.getVertexProvider?.();
      if (vertex) {
        add(new WebSearchFallbackTool({ provider: vertex }));
      }
    }
    if (modelName.startsWith('grok')) {
      const xai = modelProvider.getXaiProvider?.();
      if (xai) {
        add(new XaiWebSearchTool({ provider: xai }));
        add(new XaiXSearchTool({ provider: xai }));
      }
    }

    const cdnUploadService = new PublicCdnUploadService({
      apiBaseUrl: storageFactory.getApiBaseUrl(),
      accessKey: storageFactory.getAccessKey(),
    });
    add(new NanoBananaToolModel({ modelProvider, cdnUploadService }));

    add(
      new FirecrawlScrapeTool({
        apiBaseUrl: storageFactory.getApiBaseUrl(),
        accessKey: storageFactory.getAccessKey(),
      }),
    );

    add(
      new FirecrawlSessionTool({
        apiBaseUrl: storageFactory.getApiBaseUrl(),
        accessKey: storageFactory.getAccessKey(),
      }),
    );

    try {
      const platformBaseUrl = storageFactory.getApiBaseUrl();
      const modelAccessKey = storageFactory.getAccessKey();
      const { agentId } = getJWTPayload<{ agentId: string }>(modelAccessKey);
      add(new UseAgentTool({ platformBaseUrl, modelAccessKey, agentId }));
    } catch (error) {
      console.warn('[ToolRegistryFactory] Failed to register UseAgentTool:', error);
    }

    try {
      const mcpTools = await mcpRegistry.getAllTools();
      console.log(
        `[ToolRegistryFactory] Loaded ${mcpTools.length} tools from ${mcpRegistry.getServerCount()} MCP servers`,
      );
      for (const tool of mcpTools) {
        tools.push(tool);
      }
    } catch (error) {
      console.error('[ToolRegistryFactory] Failed to load MCP server tools:', error);
    }

    if (agentFactory) {
      const vertex = modelProvider.getVertexProvider?.();
      if (vertex) {
        add(new DeepResearchToolModel({ agentFactory, provider: vertex }));
      }
    }

    return tools;
  }

  /**
   * Full registry: built-ins + platform tools.
   *
   * Applies the schedule mutation recursion guard when sessionType === 'schedule'.
   *
   * Used by MessagingService chat path. Channels/triggers/schedules that run
   * via createAgent's hook (wired in container.ts) should use createPlatformTools
   * instead to avoid duplicating built-ins.
   */
  static async createToolRegistry(
    modelName: string,
    modelProvider: ModelProvider,
    storageFactory: AgentStorageFactoryService,
    mcpRegistry: MCPServerRegistry,
    stateTree?: StateTree | null,
    sessionType?: string,
    agentFactory?: AgentFactory,
    sessionKey?: string,
    recordsTransport?: RecordsTransport | null,
    turnContext?: TurnToolContext,
  ): Promise<ToolRegistry> {
    const toolRegistry = new ToolRegistry();

    const builtIns = getBuiltInTools(stateTree);
    const platformTools = await ToolRegistryFactory.createPlatformTools(
      modelName,
      modelProvider,
      storageFactory,
      mcpRegistry,
      agentFactory,
      sessionKey,
      stateTree,
      recordsTransport,
      turnContext,
    );

    const combined = [...builtIns, ...platformTools];
    const tools = sessionType === 'schedule' ? filterScheduleSafeTools(combined) : combined;
    for (const tool of tools) {
      toolRegistry.registerTool(tool);
    }

    // Subagent tool — delegates focused tasks to sub-agents. Must be registered
    // LAST: the child registry is a filtered snapshot of the parent, so every
    // inherited tool must already be in `toolRegistry` by this point. Skipped
    // for schedule sessions alongside the existing schedule-safety filter —
    // a child agent could do arbitrary things that we do not want in a
    // schedule-mutation context.
    if (agentFactory && sessionType !== 'schedule') {
      try {
        const defaultModel = await modelProvider.getModel(modelName);
        let subagentAgentId: string | undefined;
        try {
          subagentAgentId = getJWTPayload<{ agentId: string }>(
            storageFactory.getAccessKey(),
          ).agentId;
        } catch (error) {
          console.warn(
            '[ToolRegistryFactory] Could not extract agentId for subagent traces:',
            error,
          );
        }
        // Gateway-routed base URL — `/api/gateway` is the prefix `ModelProviderService`
        // also uses (see container.ts:163-169). Required by the code-executor's
        // `toModelOutput` hook to hit `/anthropic/v1/files/...` through the
        // platform gateway when downloading file_ids produced by `code_execution`.
        const gatewayBaseUrl = `${storageFactory.getApiBaseUrl()}/api/gateway`;
        // Built once and shared: the optional subagents (code-executor,
        // page-fetcher) and the Subagent tool's model-override param both use it.
        // A build failure is non-fatal — subagents then run on their default model.
        let modelResolver: SubagentModelResolver | null = null;
        try {
          modelResolver = await buildSubagentModelResolver(modelProvider);
        } catch (error) {
          console.warn(
            '[ToolRegistryFactory] Failed to build subagent model resolver; subagents run on defaults only:',
            error,
          );
        }
        const subagentConfigs = await createAgentSubagents({
          parentRegistry: toolRegistry,
          defaultModel,
          modelResolver,
          modelProvider,
          storageFactory,
          gatewayBaseUrl,
          accessKey: storageFactory.getAccessKey(),
          agentId: subagentAgentId,
        });
        const subagentStorage = storageFactory.getStorage(sessionKey);
        for (const subagentConfig of subagentConfigs) {
          const subagentModelId = subagentConfig.model.modelId;
          const buildSubagentContextManagement = (compactionScope: string, modelName: string) =>
            createContextManagement({
              modelName,
              storage: subagentStorage,
              sessionKey,
              modelProvider,
              gatewayBaseUrl,
              accessKey: storageFactory.getAccessKey(),
              compactionScope,
            });
          const staticScope = `sub-${sanitizeCompactionScope(subagentConfig.type)}-shared`;
          // Plan and estimator are sized for the model the spawn actually runs on.
          subagentConfig.modelMiddlewares = (spawn) =>
            buildSubagentContextManagement(
              `sub-${sanitizeCompactionScope(spawn.subagentType)}-${sanitizeCompactionScope(spawn.toolCallId)}`,
              spawn.modelId ?? subagentModelId,
            ).modelMiddlewares;
          subagentConfig.fileFirstConfig = buildSubagentContextManagement(
            staticScope,
            subagentModelId,
          ).fileFirstConfig;
          subagentConfig.agentStorage = subagentStorage;
        }
        toolRegistry.registerTool(
          createSubagentTool({
            subagents: subagentConfigs,
            agentFactory,
            modelResolver: modelResolver ?? undefined,
            allowedModels: [...SUBAGENT_ALLOWED_MODELS],
            defaultModel: SUBAGENT_DEFAULT_MODEL,
            modelDescription: SUBAGENT_MODEL_DESCRIPTION,
          }),
        );
      } catch (error) {
        console.warn('[ToolRegistryFactory] Failed to register Subagent tool:', error);
      }
    }

    return toolRegistry;
  }
}
