import { z } from 'zod';
import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';
import {
  ContentType,
  type AgentContent,
  type ComponentContent,
  type ToolContent,
} from '../types/content.ts';
import type { AgentFactory } from '../core/agent.factory.ts';
import type AgentState from '../core/agent-state.ts';
import { ToolRegistry, type IToolRegistry } from './tool-registry.ts';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LanguageModelUsage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { AgentMode } from '../types/mode.ts';
import { getAgentLogger } from '../types/logger.ts';
import type { KernelModelMiddleware } from '../kernel/middlewares/types.ts';
import type { PrepareStepCallback } from '../core/interfaces.ts';
import type { FileFirstConfig } from '../core/file-first-offloader.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';

const logger = getAgentLogger();

/**
 * Configuration for a single subagent type.
 */
export type SubagentSpawnContext = {
  toolCallId: string;
  subagentType: string;
  /**
   * Short-name the spawn runs on (the parent's pick or the schema default).
   * Undefined when the tool exposes no `model` parameter.
   */
  modelShortName?: string;
  /** `modelId` of the model this spawn actually runs on. */
  modelId?: string;
};

/**
 * Resolves the array-or-factory form of SubagentConfig.modelMiddlewares for
 * one spawn. The factory form lets consumers build per-invocation context
 * management (e.g. per-run compaction scopes).
 */
export function resolveSubagentModelMiddlewares(
  modelMiddlewares:
    | KernelModelMiddleware[]
    | ((spawn: SubagentSpawnContext) => KernelModelMiddleware[])
    | undefined,
  spawn: SubagentSpawnContext,
): KernelModelMiddleware[] | undefined {
  if (typeof modelMiddlewares === 'function') {
    return modelMiddlewares(spawn);
  }
  return modelMiddlewares;
}

export interface SubagentConfig {
  /** Subagent type identifier (e.g. "explore") */
  type: string;
  /** Description shown to parent LLM in tool description */
  description: string;
  /** System prompt for the child agent */
  systemPrompt: string;
  /** Pre-built tool registry for the child agent */
  toolRegistry: IToolRegistry;
  /** Model for the child agent */
  model: LanguageModelV3;
  /** Max LLM calls for the child (safety limit) */
  maxModelCalls: number;
  /** Optional model middlewares for the child agent — static array or per-spawn factory */
  modelMiddlewares?:
    | KernelModelMiddleware[]
    | ((spawn: SubagentSpawnContext) => KernelModelMiddleware[]);
  /** Tool-result offloading for the child agent (session-scoped storage). */
  fileFirstConfig?: FileFirstConfig;
  /** Storage the child's offloaded results are written to / read from. */
  agentStorage?: AgentStorage;
  /** Model settings (maxOutputTokens, providerOptions with reasoning config, etc.) */
  modelSettings?: {
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
  };
  /** Trace name for observability (e.g. "Explore: agentId") */
  traceName?: string;
  /**
   * Optional factory that produces a per-step hook for the child agent's tool
   * loop. Called **once per `SubagentToolModel.execute` invocation** — each
   * child agent receives its OWN freshly-built `PrepareStepCallback`, so any
   * closure state (accumulated injections, `initialMessagesLength`, etc.)
   * is isolated between concurrent sub-agent runs.
   *
   * The returned callback is invoked before every model call in the child's
   * tool loop with { stepNumber, messages }. It can return { messages } to
   * replace the messages for that step. Returned messages are NOT persisted
   * across steps — if you need retention, accumulate in the closure and
   * rebuild the messages on every call (see `injection-prepare-step.ts` or
   * `subagent-budget-step.ts` in the server for the pattern).
   *
   * Why a factory and not a plain callback: `SubagentConfig` is built once
   * per builder session and re-used for every `Subagent` tool call. If this
   * field stored a single callback instance, parallel sub-agent invocations
   * would share its closure and corrupt each other's state. The factory
   * shape guarantees a fresh closure per invocation regardless of whether
   * the builder runs sub-agents sequentially or in parallel.
   */
  prepareStep?: () => PrepareStepCallback;
  /** Forward child reasoning tokens to parent stream. Default: false */
  streamReasoning?: boolean;
  /**
   * Optional whitelist of model short-names allowed for THIS subagent.
   * Rejects `input.model` values not in the list with a retry instruction.
   * When undefined, all models from `SubagentToolConfig.allowedModels` are
   * valid. Used when a subagent requires a specific provider unavailable on
   * the parent's default route (e.g. direct-Anthropic Code Execution while
   * the parent runs on Bedrock).
   */
  allowedModelOverrides?: [string, ...string[]];
  /**
   * Fires once per `model-step-end` of the child's tool loop. Hosts use this
   * to record per-step LLM usage for billing/observability — the parent's
   * content stream doesn't see the child's model-step events.
   *
   * `provider` / `modelId` describe the model that actually ran the step.
   * Provider strings are the raw AI SDK package values (e.g.
   * `"amazon-bedrock"`, `"vertex"`, `"xai"`, `"anthropic"`, `"openai"`).
   *
   * Fire-and-forget; errors are caught and logged.
   */
  onChildStepEnd?: (info: {
    stepIndex: number;
    usage: LanguageModelUsage;
    provider: string;
    modelId: string;
    /** Provider-specific metadata from AI SDK `finish-step` (e.g. Anthropic
     *  `server_tool_use`, Vertex `groundingMetadata`); needed to bill
     *  web_search / grounding counts that `usage` doesn't expose. */
    providerMetadata?: Record<string, Record<string, unknown>>;
  }) => void;
  /**
   * Platform binding seam — wraps the inner `agent.runHandle(...)` call so
   * hosts can enter a per-subagent async-context scope (e.g.
   * `AsyncLocalStorage` for billing / tracing) without editing this library.
   * Reserved for cross-cutting platform concerns; do not use for business
   * logic. When unset, the bare `await agent.runHandle(...)` behaviour applies.
   */
  wrapRun?: <T>(inner: () => Promise<T>) => Promise<T>;
}

/**
 * Result returned by a `SubagentToolConfig.modelResolver` call. When the parent
 * LLM passes the `model` tool-call parameter, these settings override the
 * corresponding fields on the matched `SubagentConfig`.
 *
 * Resolvers can also signal a Pro-plan paywall hit by returning
 * `{ proPlanRequired: true }`. This is the analog of the gateway's 403
 * response for traffic that does NOT go through the platform gateway (e.g.
 * the builder, which calls AI providers directly with their real API keys
 * — no gateway middleware to intercept). `SubagentToolModel.execute` maps
 * this into the same friendly `buildProPlanResult` shape that the gateway
 * 403 path produces, so the parent LLM sees one consistent error contract
 * regardless of the underlying transport.
 */
export type SubagentModelResolution =
  | {
      model: LanguageModelV3;
      modelSettings?: {
        temperature?: number;
        maxOutputTokens?: number;
        providerOptions?: ProviderOptions;
      };
    }
  | { proPlanRequired: true };

/**
 * Configuration for creating a SubagentToolModel.
 */
export interface SubagentToolConfig {
  /** Available subagent types */
  subagents: SubagentConfig[];
  /** Factory to create child agents */
  agentFactory: AgentFactory;
  /** Component name for UI rendering (default: 'Subagent') */
  componentName?: string;
  /**
   * Resolves a model short-name (e.g. "sonnet") into a concrete model instance
   * plus settings. Called at execute time when the parent LLM passes `model` in
   * the tool call.
   *
   * Return `null` to signal "model not supported" — the tool will return a
   * graceful error output to the parent instead of throwing. In normal
   * operation this path is unreachable because the zod enum rejects unknown
   * values before `execute()` runs; the null branch is kept as defensive cover
   * for cache/`allowedModels` drift bugs.
   */
  modelResolver?: (shortName: string) => SubagentModelResolution | null;
  /**
   * Model short-names exposed to the parent LLM in the tool schema. Required
   * when `modelResolver` is set.
   * Example: `['sonnet', 'opus', 'gemini-flash-lite']`.
   */
  allowedModels?: [string, ...string[]];
  /**
   * Short-name the `model` parameter defaults to — materialised by the AI SDK before
   * `execute()`, so it, not `SubagentConfig.model`, is what a subagent usually runs on.
   * Must be one of `allowedModels`; falls back to the first allowed model.
   */
  defaultModel?: string;
  /**
   * Text used as the `describe()` for the `model` parameter in the tool
   * schema. Callers should include a short blurb per short-name so the
   * parent LLM can pick the right model. If omitted, a generic description
   * is used.
   */
  modelDescription?: string;
}

/**
 * A specialized ToolModel that spawns child agents for delegated tasks.
 *
 * The parent LLM calls this tool with a task description and subagent type.
 * SubagentToolModel creates a child Agent, consumes its stream, counts tool calls,
 * reports progress via onProgress, and returns the child's text output.
 */
export class SubagentToolModel extends ToolModel<{
  task: string;
  subagent: string;
  model?: string;
}> {
  private readonly _componentName: string;
  private readonly subagentMap: Map<string, SubagentConfig>;
  private readonly agentFactory: AgentFactory;
  private readonly modelResolver?: (shortName: string) => SubagentModelResolution | null;

  constructor(config: SubagentToolConfig) {
    const types = config.subagents.map((s) => s.type);
    if (types.length === 0) {
      throw new Error('SubagentToolModel requires at least one subagent config');
    }

    const subagentDescriptions = config.subagents
      .map((s) => `- "${s.type}": ${s.description}`)
      .join('\n');

    super({
      name: 'Subagent',
      description:
        'Delegate a concrete, bounded task to a specialized subagent when it can be completed independently. ' +
        'Use direct tools for a simple lookup, search, or exact file read. Give the child a self-contained task ' +
        'with the relevant context and expected final response; do not duplicate the delegated work.\n\n' +
        `Available subagents:\n${subagentDescriptions}`,
      parametersSchema: SubagentToolModel.buildParametersSchema(
        types as [string, ...string[]],
        config.allowedModels,
        Boolean(config.modelResolver),
        config.modelDescription,
        config.defaultModel,
      ),
      toolType: 'function',
      isStreaming: true,
    });

    this._componentName = config.componentName ?? 'Subagent';
    this.agentFactory = config.agentFactory;
    this.subagentMap = new Map(config.subagents.map((s) => [s.type, s]));
    this.modelResolver = config.modelResolver;
  }

  /**
   * Builds the zod parameter schema. When `hasResolver` is true and
   * `allowedModels` is non-empty, exposes an optional `model` enum parameter
   * defaulting to `defaultModel`, or to the first allowed model without one.
   *
   * Implemented as a static helper because JS requires `super()` to be the
   * first statement in a derived constructor — the schema cannot be built in
   * the constructor body before `super` is called.
   */
  private static buildParametersSchema(
    types: [string, ...string[]],
    allowedModels: [string, ...string[]] | undefined,
    hasResolver: boolean,
    modelDescription?: string,
    defaultModel?: string,
  ) {
    const base = {
      task: z
        .string()
        .describe(
          'Self-contained task with relevant context, scope, evidence needs, and expected final response',
        ),
      subagent: z.enum(types).describe('Which subagent type to use'),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Optional: names of specific tools to give the subagent. Omit to use all of the subagent's default tools.",
        ),
    };
    if (!hasResolver || !allowedModels?.length) {
      return z.object(base);
    }
    let fallback = allowedModels[0];
    if (defaultModel) {
      if (allowedModels.includes(defaultModel)) {
        fallback = defaultModel;
      } else {
        logger.warn(
          `[Subagent] defaultModel "${defaultModel}" is not in allowedModels; falling back to "${fallback}"`,
        );
      }
    }
    const describeText =
      modelDescription ?? `Which model to use for the subagent. Default: ${fallback}.`;
    return z.object({
      ...base,
      model: z.enum(allowedModels).default(fallback).describe(describeText),
    });
  }

  getComponentName(): string {
    return this._componentName;
  }

  async execute(
    input: { task: string; subagent: string; model?: string; tools?: string[] },
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    const subagentConfig = this.subagentMap.get(input.subagent);
    if (!subagentConfig) {
      return {
        output: `Unknown subagent type: "${input.subagent}"`,
        uiProps: {
          status: 'error',
          error: `Unknown subagent type: "${input.subagent}"`,
        },
      };
    }

    const { task, subagent: subagentType } = input;

    let model = subagentConfig.model;
    let modelSettings = subagentConfig.modelSettings;
    if (input.model && this.modelResolver) {
      if (
        subagentConfig.allowedModelOverrides &&
        !subagentConfig.allowedModelOverrides.includes(input.model)
      ) {
        const allowed = subagentConfig.allowedModelOverrides.join(', ');
        return {
          output:
            `The "${subagentType}" subagent requires one of these models: ${allowed}. ` +
            `You passed "${input.model}". Retry the Subagent tool call with one of the allowed models.`,
          uiProps: {
            status: 'error',
            error: `Model "${input.model}" not allowed for ${subagentType}`,
          },
        };
      }
      const resolved = this.modelResolver(input.model);
      if (!resolved) {
        return {
          output: `Model "${input.model}" is not supported.`,
          uiProps: { status: 'error', error: `Unsupported model: ${input.model}` },
        };
      }
      if ('proPlanRequired' in resolved) {
        return buildProPlanResult(subagentType, task, input.model);
      }
      model = resolved.model;
      modelSettings = resolved.modelSettings ?? subagentConfig.modelSettings;
    }

    ctx.onProgress?.({
      status: 'running',
      subagentType,
      task,
      toolCount: 0,
    });

    try {
      // After the model override, so factory middlewares size limits for the model that runs.
      const resolvedModelMiddlewares = resolveSubagentModelMiddlewares(
        subagentConfig.modelMiddlewares,
        {
          toolCallId: ctx.toolCallId,
          subagentType,
          modelShortName: input.model,
          modelId: model.modelId,
        },
      );

      const parentState = ctx.runner.state as AgentState | undefined;
      const parentApp = parentState?.getApp?.();

      let toolRegistry = subagentConfig.toolRegistry;
      if (input.tools && input.tools.length > 0) {
        const allowed = new Set(input.tools);
        // Visitor-audience tools never reach a subagent, regardless of which
        // path assembled the registry — the parent owns the visitor voice.
        const filtered = toolRegistry
          .getAllTools()
          .filter((t) => allowed.has(t.name) && t.getAudience() !== 'visitor');
        // Warn on unknown names — a typo would otherwise silently yield an empty registry.
        const known = new Set(filtered.map((t) => t.name));
        const unknown = input.tools.filter((name) => !known.has(name));
        if (unknown.length > 0) {
          logger.warn('[SubagentTool] requested tools not found in the registry (ignored)', {
            unknown,
            subagentType,
          });
        }
        const filteredRegistry = new ToolRegistry();
        filteredRegistry.registerTools(filtered);
        toolRegistry = filteredRegistry;
      }

      const agent = this.agentFactory.create({
        systemInstruction: subagentConfig.systemPrompt,
        toolRegistry,
        model,
        limits: { maxModelCalls: subagentConfig.maxModelCalls },
        agentMode: AgentMode.Agent,
        modelMiddlewares: resolvedModelMiddlewares,
        fileFirstConfig: subagentConfig.fileFirstConfig,
        agentStorage: subagentConfig.agentStorage,
        modelSettings,
        state: { kernel: { conversationHistory: [] }, app: parentApp },
        traceName: subagentConfig.traceName,
        prepareStep: subagentConfig.prepareStep?.(),
      });

      const runInner = (): ReturnType<typeof agent.runHandle> => agent.runHandle({ query: task });
      const handle = subagentConfig.wrapRun
        ? await subagentConfig.wrapRun(runInner)
        : await runInner();

      // Drain events in parallel — model-step-end events carry per-step
      // usage, which the content stream below never surfaces.
      if (subagentConfig.onChildStepEnd) {
        const onChildStepEnd = subagentConfig.onChildStepEnd;
        const resolvedModelId = (model as { modelId?: string }).modelId ?? 'unknown';
        const resolvedProvider = (model as { provider?: string }).provider ?? 'unknown';
        void (async () => {
          try {
            for await (const ev of handle.events) {
              if (ev.type === 'model-step-end' && ev.usage) {
                try {
                  onChildStepEnd({
                    stepIndex: ev.stepIndex,
                    usage: ev.usage,
                    provider: resolvedProvider,
                    modelId: resolvedModelId,
                    ...(ev.providerMetadata && { providerMetadata: ev.providerMetadata }),
                  });
                } catch (err) {
                  logger.warn('[SubagentTool] onChildStepEnd threw', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          } catch {
            // events stream errors are non-fatal; the content stream still
            // produces a valid result.
          }
        })();
      }

      let toolCount = 0;
      let lastToolName: string | undefined;
      let resultText = '';

      const MAX_RECENT = 2;
      type RecentTool = {
        toolCallId: string;
        componentName: string;
        props: Record<string, unknown>;
        state: string;
        toolName: string;
      };
      let recentTools: RecentTool[] = [];

      for await (const content of handle.stream as AsyncIterable<AgentContent>) {
        if (ctx.abortSignal?.aborted) {
          handle.stream.abort();
          break;
        }

        if (content.type === ContentType.Text) {
          if (!content.isReasoning) {
            resultText += content.content;

            if (recentTools.length > 0) {
              recentTools = [];
              ctx.onProgress?.({
                status: 'running',
                subagentType,
                task,
                toolCount,
                lastToolName,
                recentTools: [],
              });
            }

            ctx.streamText?.({
              type: 'text',
              text: content.content,
              messageId: content.messageId,
            });
          } else if (subagentConfig.streamReasoning) {
            ctx.streamText?.({
              type: 'reasoning',
              text: content.content,
              messageId: content.messageId,
            });
          }
        }

        if (content.type === ContentType.Component) {
          const comp = content as ComponentContent;
          const tcId = comp.streaming?.toolCallId;
          const state = comp.streaming?.state;

          if (
            tcId &&
            (state === 'output-pending' || state === 'output-available' || state === 'output-error')
          ) {
            const entry: RecentTool = {
              toolCallId: tcId,
              componentName: comp.componentName,
              props: comp.props ?? {},
              state,
              toolName: comp.streaming?.toolName ?? comp.componentName,
            };

            const idx = recentTools.findIndex((t) => t.toolCallId === tcId);
            if (idx >= 0) {
              recentTools[idx] = entry;
            } else {
              recentTools.push(entry);
              if (recentTools.length > MAX_RECENT) {
                recentTools = recentTools.slice(-MAX_RECENT);
              }
            }

            if (state === 'output-available' || state === 'output-error') {
              toolCount++;
              lastToolName = comp.streaming?.toolName;
            }

            ctx.onProgress?.({
              status: 'running',
              subagentType,
              task,
              toolCount,
              lastToolName,
              recentTools: [...recentTools],
            });
          }
        }

        // Non-UI tools emit ToolContent instead of ComponentContent; mirror
        // the counter/progress logic from the Component branch above.
        if (content.type === ContentType.Tool) {
          const toolContent = content as ToolContent;
          const tcId = toolContent.streaming?.toolCallId;
          const state = toolContent.streaming?.state;

          if (tcId && (state === 'output-available' || state === 'output-error')) {
            const toolName = toolContent.streaming?.toolName ?? toolContent.tool.name;
            const entry: RecentTool = {
              toolCallId: tcId,
              componentName: toolName,
              props: (toolContent.content as Record<string, unknown>) ?? {},
              state,
              toolName,
            };

            const idx = recentTools.findIndex((t) => t.toolCallId === tcId);
            if (idx >= 0) {
              recentTools[idx] = entry;
            } else {
              recentTools.push(entry);
              if (recentTools.length > MAX_RECENT) {
                recentTools = recentTools.slice(-MAX_RECENT);
              }
            }

            toolCount++;
            lastToolName = toolName;

            ctx.onProgress?.({
              status: 'running',
              subagentType,
              task,
              toolCount,
              lastToolName,
              recentTools: [...recentTools],
            });
          }
        }
      }

      const outcome = await handle.done;

      const wasLimited =
        (outcome.status === 'ok' && outcome.stopReason === 'max-steps') ||
        (outcome.status === 'ok' && outcome.finishReason === 'length');

      if (wasLimited && outcome.status === 'ok') {
        logger.info('[SubagentToolModel] Subagent hit execution limit, forcing summary call', {
          subagentType,
          stopReason: outcome.stopReason,
          finishReason: outcome.finishReason,
          toolCount,
        });

        try {
          const summaryAgent = this.agentFactory.create({
            systemInstruction:
              'You reached your execution limit. Based on the full conversation history above, provide a comprehensive summary of all your findings, results, and any work that remains incomplete.',
            model,
            limits: { maxModelCalls: 1 },
            agentMode: AgentMode.Agent,
            modelMiddlewares: resolvedModelMiddlewares,
            modelSettings,
            state: { kernel: { conversationHistory: outcome.history }, app: parentApp },
          });

          // Route the forced-summary call through wrapRun too; otherwise
          // the parent's ALS frame is still active and the summary leaks
          // out as parent-attributed instead of subagent-attributed.
          const summaryInner = (): ReturnType<typeof summaryAgent.runHandle> =>
            summaryAgent.runHandle({ query: 'Summarize your findings and results.' });
          const summaryHandle = subagentConfig.wrapRun
            ? await subagentConfig.wrapRun(summaryInner)
            : await summaryInner();

          let summaryText = '';
          for await (const content of summaryHandle.stream as AsyncIterable<AgentContent>) {
            if (ctx.abortSignal?.aborted) {
              summaryHandle.stream.abort();
              break;
            }
            if (content.type === ContentType.Text && !content.isReasoning) {
              summaryText += content.content;
              ctx.streamText?.({
                type: 'text',
                text: content.content,
                messageId: content.messageId,
              });
            }
          }
          await summaryHandle.done;

          return {
            output: summaryText || resultText || '(Subagent reached execution limit)',
            uiProps: {
              status: 'completed',
              subagentType,
              task,
              toolCount,
            },
          };
        } catch (summaryError) {
          logger.warn('[SubagentToolModel] Summary call failed, returning partial result', {
            error: summaryError instanceof Error ? summaryError.message : String(summaryError),
          });
        }
      }

      if (outcome.status === 'error' && isProPlanError(outcome.error)) {
        return buildProPlanResult(subagentType, task, input.model);
      }

      const finalStatus = outcome.status === 'ok' ? 'completed' : 'error';

      return {
        output: resultText || '(No text output from subagent)',
        uiProps: {
          status: finalStatus,
          subagentType,
          task,
          toolCount,
          ...(finalStatus === 'error' && {
            error: `Subagent ended with status: ${outcome.status}`,
          }),
        },
      };
    } catch (error) {
      if (isProPlanError(error)) {
        return buildProPlanResult(subagentType, task, input.model);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[SubagentToolModel] Error running subagent', { error: errorMessage });

      return {
        output: `Subagent error: ${errorMessage}`,
        uiProps: {
          status: 'error',
          subagentType,
          task,
          toolCount: 0,
          error: errorMessage,
        },
      };
    }
  }
}

/**
 * Detects the platform gateway's Pro-plan 403 response. When the user-facing
 * agent's subagent is asked to run on a Pro model (opus / gemini-pro /
 * gpt-5-4) and the owner is on the Free plan, the gateway returns HTTP 403
 * with `code: 'pro_model_requires_paid_plan'`. AI SDK surfaces that as an
 * `APICallError` with `statusCode` and a JSON `responseBody`; this helper
 * narrows both error-propagation paths (thrown during stream iteration OR
 * reported via `outcome.status: 'error'`) to the same predicate.
 */
export function isProPlanError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; responseBody?: unknown };
  if (e.statusCode !== 403) return false;

  let parsed: { error?: { code?: string } } | null = null;
  if (typeof e.responseBody === 'string') {
    try {
      parsed = JSON.parse(e.responseBody) as { error?: { code?: string } };
    } catch {
      return false;
    }
  } else if (e.responseBody && typeof e.responseBody === 'object') {
    parsed = e.responseBody as { error?: { code?: string } };
  }
  return parsed?.error?.code === 'pro_model_requires_paid_plan';
}

/**
 * Renders the "Free plan cannot use this Pro model" case into a subagent
 * tool result: user sees a short, laconic error label, and the parent LLM
 * receives a fuller instruction in `output` so it can retry with a
 * non-Pro model without involving the user.
 */
function buildProPlanResult(
  subagentType: string,
  task: string,
  attemptedModel?: string,
): ToolExecuteResult {
  const which = attemptedModel
    ? `the model "${attemptedModel}"`
    : 'the model selected for this call';
  return {
    output:
      `The user's account is on the Free plan, which does not include ${which}. ` +
      'This Subagent call was blocked before running. Either retry with a different model, ' +
      'or — if no available model can do the task — tell the user the requested feature ' +
      'requires a Paid plan. Only mention the subscription gating if relevant to the request.',
    uiProps: {
      status: 'error',
      subagentType,
      task,
      toolCount: 0,
      error: 'Paid plan required for this model',
    },
  };
}

/**
 * Factory function to create a subagent tool.
 */
export function createSubagentTool(config: SubagentToolConfig): SubagentToolModel {
  return new SubagentToolModel(config);
}
