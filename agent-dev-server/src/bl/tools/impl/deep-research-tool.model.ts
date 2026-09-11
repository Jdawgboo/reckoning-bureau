/**
 * DeepResearchToolModel
 *
 * A tool that spawns a research sub-agent to perform thorough web research.
 * Follows the SubagentToolModel pattern (vendor/agent-library/tools/subagent-tool.ts)
 * but tracks ALL search queries and captures structured source data from
 * DeepWebSearchTool's uiProps.
 *
 * The parent LLM calls this with a research query. The tool creates a child agent
 * that performs multiple web searches, tracks sources, and returns synthesized findings.
 */
import { z } from 'zod';
import {
  ToolModel,
  type ToolExecuteResult,
  type ToolExecuteContext,
  ContentType,
  type AgentContent,
  type ToolContent,
  type AgentFactory,
  type AgentState,
  AgentMode,
  ToolRegistry,
  GetCurrentTimeTool,
} from '../../agent/agent-library.ts';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { DevServerAppState } from '../../agent/agent-state.ts';
import { DeepWebSearchTool } from './deep-web-search.tool.ts';
import { DEEP_RESEARCH_SYSTEM_PROMPT } from './deep-research-prompt.ts';

const TOOL_NAME = 'deep_research';
const COMPONENT_NAME = 'DeepResearch';
const SEARCH_TOOL_NAME = 'deep_web_search';
const MAX_MODEL_CALLS = 25;
/**
 * How many completed searches separate two spoken progress facts. Research
 * runs long, and a fact per search is a stream of near-identical sentences —
 * the listener learns nothing from the fourth one that the third did not say.
 */
const PROGRESS_SEARCH_INTERVAL = 3;

const deepResearchParamsSchema = z.object({
  query: z
    .string()
    .describe(
      'The research question or topic to investigate thoroughly across multiple web sources',
    ),
});

type DeepResearchParams = z.infer<typeof deepResearchParamsSchema>;

interface Source {
  url: string;
  domain: string;
  title?: string;
}

export interface DeepResearchToolModelConfig {
  agentFactory: AgentFactory;
  provider: GoogleVertexProvider;
}

export class DeepResearchToolModel extends ToolModel<DeepResearchParams> {
  readonly #agentFactory: AgentFactory;
  readonly #provider: GoogleVertexProvider;

  constructor(config: DeepResearchToolModelConfig) {
    super({
      name: TOOL_NAME,
      toolType: 'function',
      description: `Perform deep web research on a topic by searching multiple sources and synthesizing findings.
Use this when the user needs thorough, well-sourced information that requires consulting many web sources.
NOT for simple factual questions — use web_search for those instead.`,
      parametersSchema: deepResearchParamsSchema,
      isStreaming: true,
    });

    this.#agentFactory = config.agentFactory;
    this.#provider = config.provider;
  }

  getComponentName(): string {
    return COMPONENT_NAME;
  }

  async execute(input: DeepResearchParams, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const { query } = input;

    // Emit initial progress
    ctx.onProgress?.({
      status: 'running',
      query,
      searchCount: 0,
      searches: [],
      sources: [],
    });

    try {
      const parentState = ctx.runner.state as AgentState | undefined;
      const parentApp = parentState?.getApp<DevServerAppState>();

      // Build child agent's tool registry
      const childToolRegistry = new ToolRegistry();
      childToolRegistry.registerTool(new DeepWebSearchTool({ provider: this.#provider }));
      childToolRegistry.registerTool(new GetCurrentTimeTool());

      // 3.5 Flash-Lite for stronger agentic tool-use + long-context synthesis
      // across many sources (Terminal-Bench / GDPval / MRCR gains over 3.1). The
      // nested DeepWebSearchTool stays on cheaper 3.1 Flash-Lite for extraction.
      const childModel = this.#provider('gemini-3.5-flash-lite');

      const agent = this.#agentFactory.create({
        systemInstruction: DEEP_RESEARCH_SYSTEM_PROMPT,
        toolRegistry: childToolRegistry,
        model: childModel,
        limits: { maxModelCalls: MAX_MODEL_CALLS },
        agentMode: AgentMode.Agent,
        state: { kernel: { conversationHistory: [] }, app: parentApp },
        traceName: `DeepResearch: ${parentApp?.agentId ?? 'unknown'}`,
      });

      const handle = await agent.runHandle({ query });

      // Track research progress
      let searchCount = 0;
      const searches: string[] = [];
      const allSources: Source[] = [];
      const seenUrls = new Set<string>();
      let resultText = '';
      let lastReportedSearchCount = 0;
      let lastReportedSourceCount = 0;

      for await (const content of handle.stream as AsyncIterable<AgentContent>) {
        if (ctx.abortSignal?.aborted) {
          handle.stream.abort();
          break;
        }

        // Accumulate text output
        if (content.type === ContentType.Text && !content.isReasoning) {
          resultText += content.content;
        }

        // Track tool calls for search queries and sources.
        // DeepWebSearchTool is a plain ToolModel (no getComponentName override) so
        // the runtime emits ToolContent events — not ComponentContent — for it.
        if (content.type === ContentType.Tool) {
          const toolContent = content as ToolContent;
          const toolName = toolContent.streaming?.toolName;
          const state = toolContent.streaming?.state;

          if (toolName === SEARCH_TOOL_NAME) {
            if (state === 'input-available') {
              const input = toolContent.streaming?.input;
              const queryText = input?.query as string;
              if (queryText && !searches.includes(queryText)) {
                searches.push(queryText);
                ctx.onProgress?.({
                  status: 'running',
                  query,
                  searchCount,
                  searches: [...searches],
                  currentSearch: queryText,
                  sources: [...allSources],
                });
              }
            }

            if (state === 'output-available') {
              searchCount++;

              const props = toolContent.content as Record<string, unknown> | undefined;
              const sources = props?.sources as Source[] | undefined;
              if (sources) {
                for (const source of sources) {
                  if (!seenUrls.has(source.url)) {
                    seenUrls.add(source.url);
                    allSources.push(source);
                  }
                }
              }

              const milestone =
                searchCount === 1 ||
                searchCount - lastReportedSearchCount >= PROGRESS_SEARCH_INTERVAL;
              const progress =
                milestone && allSources.length > lastReportedSourceCount
                  ? {
                      text: `Checked ${searchCount} ${searchCount === 1 ? 'search' : 'searches'} and found ${allSources.length} distinct ${allSources.length === 1 ? 'source' : 'sources'}.`,
                    }
                  : undefined;
              if (progress) {
                lastReportedSearchCount = searchCount;
                lastReportedSourceCount = allSources.length;
              }

              ctx.onProgress?.(
                {
                  status: 'running',
                  query,
                  searchCount,
                  searches: [...searches],
                  sources: [...allSources],
                },
                progress,
              );
            }
          }
        }
      }

      const outcome = await handle.done;
      const finalStatus = outcome.status === 'ok' ? 'completed' : 'error';
      const cappedResult =
        resultText.length > 3000 ? `${resultText.slice(0, 3000)}...` : resultText;

      return {
        output: resultText || '(No research output)',
        uiProps: {
          status: finalStatus,
          query,
          searchCount,
          searches,
          sources: allSources,
          resultText: cappedResult,
          ...(finalStatus === 'error' && {
            error: `Research ended with status: ${outcome.status}`,
          }),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[DeepResearchToolModel] Error running research', errorMessage);

      return {
        output: `Research error: ${errorMessage}`,
        uiProps: {
          status: 'error',
          query,
          searchCount: 0,
          searches: [],
          sources: [],
          error: errorMessage,
        },
      };
    }
  }
}
