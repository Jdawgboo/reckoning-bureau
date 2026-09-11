/**
 * AgentService
 *
 * Streaming adapter between ActionAgent and the framework runner (`AgentRunner`).
 *
 * Responsibilities:
 * - convert ToolRegistry tools into ToolDefinition[] and AI SDK Tool[]
 * - execute server tools via `ToolModel.execute(...)` when the runner requests it
 * - translate runner events (`AgentStreamEvent`) into UI stream content
 * - return a single `AgentRunOutcome` for ActionAgent to decide retry/stop
 */
import type { IToolRegistry } from '../tools/tool-registry.ts';
import type { ToolModel, ToolRunnerEvent, ToolExecuteContext } from '../tools/tool-model.ts';
import { isBinaryToolOutput } from '../runners/tool-loop-agent/tool-loop-agent.tool-output.ts';
import type { ToolPartState, UserFacingProgress } from '../types/content.ts';
import { generateShortId } from '../types/id.ts';
import { getAgentLogger } from '../types/logger.ts';
import { logAgentError } from '../util/log-agent-error.ts';
import { normalizeError } from '../util/normalize-error.ts';
import { plainTextFromMarkdown } from '../util/markdown-plain.ts';
import type AgentState from './agent-state.ts';
import type { UiSink } from '../kernel/ui-sink.ts';
import { ContentCapture, type PendingAssistantText } from './content-capture.ts';
import type { ToolInvocationContext } from '../kernel/tooling.ts';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type {
  AgentRunner,
  AgentRunnerHandle,
  AgentStreamEvent,
  FinishReason,
} from '../runners/agent-runner.ts';
import type { ToolDefinition } from '../kernel/tooling.ts';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { Tool as AiSdkTool, LanguageModelUsage } from 'ai';
import type { ZodType } from 'zod';
import type { PrepareStepCallback } from './interfaces.ts';
import type { StopCondition, ToolSet } from 'ai';
import type { TraceOrchestrator, TraceRun } from '../telemetry/trace-orchestrator.ts';
import {
  DEFAULT_TOOL_OUTPUT_CHAR_LIMIT,
  applyToolOutputCharLimit,
  wrapAiSdkToolWithOutputCap,
} from '../defaults/middlewares/tool-output-limit.ts';
import { getLangfuseTraceOrchestrator } from '../telemetry/langfuse.ts';
import type { EventSink } from '../types/event-stream.ts';
import { offloadToolResult, type FileFirstConfig } from './file-first-offloader.ts';
import { AguiEmitter } from '../agui/emitter.ts';
import { AguiContentProjector } from '../agui/content-projector.ts';
import { aguiEvent, AGUI_CUSTOM_EVENT_NAMES, type AguiEvent } from '../agui/events.ts';
import { isHeadlessSessionType, resolveHeadlessOutput } from './blocking.ts';
import type { SessionType } from '../sessions/types.ts';
import { createStreamingComponent } from '../types/content.ts';
import {
  createComponentPropsResolver,
  type ComponentPropsResolver,
} from '../kernel/utils/component-props-resolver.ts';

const logger = getAgentLogger();

export interface AgentServiceConfig {
  toolRegistry: IToolRegistry;
  state: AgentState;
  abortController?: AbortController;
  runner: AgentRunner;
  traceOrchestrator?: TraceOrchestrator;
  /** Current session ID — passed through to ToolExecuteContext for tools that need session awareness. */
  sessionId?: string;
  /** File-first offloading config. When set, large tool results are written to disk. */
  fileFirstConfig?: FileFirstConfig;
  /** AgentStorage for file-first offloading and unified data access */
  agentStorage?: import('../storage/agent-storage.ts').AgentStorage;
}

export interface AgentRunOptions {
  model: LanguageModelV3;
  instructions: string;
  messages: ModelMessage[];
  ui: UiSink;
  /** Optional event sink for raw AgentStreamEvent forwarding */
  eventSink?: EventSink;
  maxSteps?: number;
  stopAtToolNames?: string[];
  structuredOutputSchema?: ZodType<unknown>;
  modelSettings?: {
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
  };
  prepareStep?: PrepareStepCallback;
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /** Optional observer of the native AG-UI event stream. */
  aguiSink?: (ev: AguiEvent) => void;
  /** Session type for this run — drives the headless blocking policy. Defaults to 'web'. */
  sessionType?: SessionType;
}

export type StepUsage = {
  stepIndex: number;
  usage: import('ai').LanguageModelUsage;
};

export type AgentRunOutcome =
  | {
      status: 'ok';
      history: ModelMessage[];
      stoppedByToolName?: string;
      structuredOutput?: unknown;
      stopReason?: 'max-steps';
      finishReason?: FinishReason;
      steps?: StepUsage[];
      /** True when the run's last model call returned no content and no output tokens. */
      finalStepEmpty?: boolean;
      /**
       * True when the provider itself reported zero output tokens for an empty
       * final step. Narrower than {@link finalStepEmpty}, which is also true when
       * the provider sent no counters at all — a shape some providers use for a
       * legitimate completion.
       */
      finalStepReportedZeroOutput?: boolean;
    }
  | { status: 'aborted'; history: ModelMessage[] }
  | { status: 'error'; history: ModelMessage[]; error: unknown };

export class AgentService {
  private config: AgentServiceConfig;
  private toolModelMap: Map<string, ToolModel<unknown>> = new Map();
  private abortController: AbortController;
  private runner: AgentRunner;
  private traceOrchestrator?: TraceOrchestrator;

  private tempIdForText: string | null = null;
  private tempIdForReasoning: string | null = null;

  #contentCapture: ContentCapture | null = null;
  #agui: AguiEmitter | null = null;

  /** Track accumulated input deltas for tools using the new execute() API */
  private toolPartDeltas: Map<string, string> = new Map();

  /** Last component identity that received input for each active tool call. */
  #visibleToolInputComponents: Map<string, string> = new Map();

  /** Parses accumulated `streamPartialInput` buffers into structured objects. */
  #componentPropsResolver: ComponentPropsResolver = createComponentPropsResolver();

  /**
   * Sources accumulated for the current model step. Keyed by URL (or
   * title fallback for sourceless entries) to dedupe — providers may
   * emit the same URL multiple times when the model references it more
   * than once. Flushed as a single `Sources` UI component when the step
   * ends, then cleared.
   */
  private currentStepSources: Map<string, { url?: string; title?: string }> = new Map();

  constructor(config: AgentServiceConfig) {
    this.config = config;
    this.abortController = config.abortController ?? new AbortController();
    this.runner = config.runner;
    this.traceOrchestrator = config.traceOrchestrator;
    this.buildToolModelMap();
  }

  /**
   * Emit a streaming component with the given state.
   *
   * Note: Tool output is intentionally NOT sent to the UI.
   * - The model receives output via toModelOutput in tools.ts
   * - The UI receives curated data via `props` (from uiProps)
   * - Sending raw output would cause massive payloads (e.g., 16MB from url-file-reader)
   */
  private emitStreamingComponent(
    _ui: UiSink,
    toolCallId: string,
    toolName: string,
    state: ToolPartState,
    updates?: {
      inputDelta?: string;
      input?: Record<string, unknown>;
      error?: string;
      props?: Record<string, unknown>;
      /**
       * Plain-text fallback for channels without a renderer for this component
       * AND no markdown support. Populated from ToolExecuteResult.output (when
       * string) at output-available, or from the error message at output-error.
       */
      fallbackText?: string;
      /**
       * Markdown projection supplied by the tool
       * (ToolExecuteResult.fallbackMarkdown).
       */
      fallbackMarkdown?: string;
      progress?: UserFacingProgress;
    },
  ): void {
    const tool = this.toolModelMap.get(toolName);
    // Only UI components flow through the content stream. Plain ToolModels
    // (data fetchers, side-effect tools) don't render — their results go to
    // the LLM via conversation history, and the LLM produces the user-facing
    // narrative. Emitting ComponentContent for them caused channels (Discord,
    // Slack, Telegram) to render the raw tool output as fallback text on top
    // of the LLM's narrative — duplication.
    if (!tool) {
      return;
    }
    const componentName = tool.getComponentName(toolCallId);
    if (!componentName) {
      const x = {
        toolName,
        input: updates?.input,
        inputDelta: updates?.inputDelta,
        progress: updates?.progress,
      };
      if (state === 'input-available') {
        this.#agui?.emit(aguiEvent.toolCallStart({ toolCallId, toolCallName: toolName, x }));
        this.#agui?.emit(
          aguiEvent.toolCallArgs({ toolCallId, delta: JSON.stringify(updates?.input ?? {}), x }),
        );
        this.#agui?.emit(aguiEvent.toolCallEnd({ toolCallId, x }));
      } else if (state === 'output-available' || state === 'output-error') {
        this.#agui?.emit(
          aguiEvent.toolCallResult({
            toolCallId,
            toolCallName: toolName,
            x: {
              toolName,
              input: updates?.input,
              inputDelta: updates?.inputDelta,
              progress: updates?.progress,
              ...(state === 'output-error' ? { isError: true, errorMessage: updates?.error } : {}),
            },
          }),
        );
      }
      if (state === 'input-available' || state === 'output-available' || state === 'output-error') {
        this.#agui?.emit(
          aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.toolContent, {
            toolCallId,
            toolName,
            state,
            input: updates?.input,
            content: updates?.props,
            progress: updates?.progress,
          }),
        );
      }
      return;
    }
    // Per-tool opt-out of progressive arg-streaming. When the tool config sets
    // `isStreaming: false`, the kernel skips delta emits — renderers see
    // `input-available` first. See docs/component-rendering.md.
    if (state === 'input-streaming' && !tool.isStreaming) {
      return;
    }
    // Silent-retry suppression for Pattern A tools. When a visitor-audience
    // tool returns `{ output }` without `uiProps` (e.g. its catch path expects
    // the LLM to retry with corrected input), skip the user-visible terminal
    // emit. The LLM still sees the tool result via the AI-SDK tool-result
    // message. See docs/component-rendering.md § Rules that bite.
    if (
      state === 'output-available' &&
      tool.getAudience() === 'visitor' &&
      updates?.props === undefined
    ) {
      return;
    }
    const fallbackMarkdown = state === 'output-available' ? updates?.fallbackMarkdown : undefined;

    // Translate to native AG-UI events. componentName + toolName ride every
    // event's `x` so the projector remembers tool metadata regardless of which
    // event is first contact (non-streaming tools skip input-streaming).
    const x = {
      componentName,
      toolName,
      input: updates?.input,
      inputDelta: updates?.inputDelta,
      progress: updates?.progress,
    };
    if (state === 'input-streaming') {
      if (updates?.inputDelta === undefined || updates.inputDelta === '') {
        this.#agui?.emit(aguiEvent.toolCallStart({ toolCallId, toolCallName: toolName, x }));
      } else {
        this.#agui?.emit(aguiEvent.toolCallArgs({ toolCallId, delta: updates.inputDelta, x }));
      }
    } else if (state === 'input-available') {
      this.#agui?.emit(aguiEvent.toolCallEnd({ toolCallId, x }));
    } else if (state === 'output-pending') {
      this.#agui?.emit(
        aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.toolPhase, {
          toolCallId,
          state: 'output-pending',
          componentName,
          toolName,
          input: updates?.input,
          inputDelta: updates?.inputDelta,
          props: updates?.props,
          progress: updates?.progress,
        }),
      );
    } else if (state === 'output-available') {
      this.#agui?.emit(
        aguiEvent.toolCallResult({
          toolCallId,
          toolCallName: toolName,
          x: {
            componentName,
            toolName,
            input: updates?.input,
            inputDelta: updates?.inputDelta,
            props: updates?.props,
            fallbackText: updates?.fallbackText,
            fallbackMarkdown,
            progress: updates?.progress,
          },
        }),
      );
    } else if (state === 'output-error') {
      this.#agui?.emit(
        aguiEvent.toolCallResult({
          toolCallId,
          toolCallName: toolName,
          x: {
            componentName,
            toolName,
            isError: true,
            errorMessage: updates?.error,
            input: updates?.input,
            inputDelta: updates?.inputDelta,
            fallbackText: updates?.fallbackText,
          },
        }),
      );
    }
  }

  /**
   * The stream's unfinalized assistant text (id + accumulated text +
   * responseId), or null when nothing is pending. Read by `Agent` teardown to
   * durably persist partially streamed output when a run ends without
   * completing (abort/error).
   */
  pendingAssistantText(): PendingAssistantText | null {
    return this.#contentCapture?.pendingAssistantText() ?? null;
  }

  async stream(options: AgentRunOptions): Promise<AgentRunOutcome> {
    const ui = new ContentCapture(options.ui, () => this.config.state.getResponseId());
    this.#contentCapture = ui;
    const agui = new AguiEmitter({
      projector: new AguiContentProjector(ui, () => this.config.state.getResponseId()),
      sink: options.aguiSink,
    });
    this.#agui = agui;
    agui.emit(
      aguiEvent.runStarted({
        runId: this.config.state.getResponseId() ?? 'run',
        threadId: this.config.sessionId,
      }),
    );
    const eventSink = options.eventSink;

    const toolDefinitions: ToolDefinition[] = this.config.toolRegistry
      .getAllTools()
      .map((t) => t.getDefinition());

    const aiSdkToolset: Record<string, AiSdkTool<unknown, unknown>> = {};
    for (const toolModel of this.config.toolRegistry.getAllTools()) {
      const tool = toolModel.getAiSdkTool();
      if (!tool) {
        continue;
      }
      const name = toolModel.getName();
      if (aiSdkToolset[name]) {
        logger.warn('[AgentService] Duplicate AI SDK tool name', { toolName: name });
        continue;
      }
      // Native AI-SDK tools bypass executeTool; cap via toModelOutput wrapper.
      const limit = toolModel.outputCharLimit ?? DEFAULT_TOOL_OUTPUT_CHAR_LIMIT;
      aiSdkToolset[name] = wrapAiSdkToolWithOutputCap(tool, limit, name);
    }

    const stopAt = Array.isArray(options.stopAtToolNames) ? new Set(options.stopAtToolNames) : null;
    let stoppedByToolName: string | undefined;
    let streamError: unknown | undefined;
    let aborted = false;
    let structuredOutput: unknown | undefined;
    let stopReason: 'max-steps' | undefined;
    let finishReason: FinishReason | undefined;

    const executeTool = async (params: {
      toolName: string;
      toolCallId: string;
      input: unknown;
      rawArgs: string;
    }): Promise<unknown> => {
      const toolModel = this.toolModelMap.get(params.toolName);
      if (!toolModel?.execute) {
        throw new Error(`[AgentService] Tool '${params.toolName}' must implement execute()`);
      }

      const input = params.input as Record<string, unknown>;
      const accumulatedDelta = this.toolPartDeltas.get(params.toolCallId) ?? '';

      // Emit input-available state
      this.emitStreamingComponent(ui, params.toolCallId, params.toolName, 'input-available', {
        input,
        inputDelta: accumulatedDelta,
      });

      // Emit output-pending state
      this.emitStreamingComponent(ui, params.toolCallId, params.toolName, 'output-pending', {
        input,
        inputDelta: accumulatedDelta,
      });

      try {
        const executeCtx: ToolExecuteContext = {
          runner: {
            state: this.config.state,
            abortSignal: this.abortController.signal,
          },
          abortSignal: this.abortController.signal,
          toolCallId: params.toolCallId,
          sessionId: this.config.sessionId,
          sessionType: options.sessionType ?? 'web',
          onProgress: (props: Record<string, unknown>, progress?: UserFacingProgress) => {
            this.emitStreamingComponent(ui, params.toolCallId, params.toolName, 'output-pending', {
              input,
              inputDelta: accumulatedDelta,
              props,
              progress,
            });
          },
          streamText: (delta) => {
            const messageId = `${params.toolCallId}:${delta.messageId}`;
            if (delta.type === 'reasoning') {
              this.#agui?.emit(aguiEvent.reasoningChunk({ messageId, delta: delta.text }));
            } else {
              this.#agui?.emit(aguiEvent.textChunk({ messageId, delta: delta.text }));
            }
          },
          emitCustomEvent: (name: string, value: unknown) => {
            this.#agui?.emit(aguiEvent.custom(name, value));
          },
        };

        logger.info(`[AgentService] Tool execute START`, {
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          input: JSON.stringify(input),
        });

        const result = await toolModel.execute(input, executeCtx);
        let output = result.output;

        if (result.status === 'pending') {
          const sessionType = options.sessionType ?? 'web';
          if (isHeadlessSessionType(sessionType)) {
            output = resolveHeadlessOutput(toolModel.getHeadlessPolicy() ?? 'skip', sessionType);
            logger.warn('[AgentService] Blocking tool in headless run — auto-resolved', {
              toolName: params.toolName,
              toolCallId: params.toolCallId,
              sessionType,
            });
          } else {
            this.config.state.markPendingToolCall(params.toolCallId);
          }
        }

        // File-first offloading: write large results via agentStorage, replace with compact reference
        if (this.config.fileFirstConfig && this.config.agentStorage && typeof output === 'string') {
          const storage = this.config.agentStorage;
          const writeConfig: FileFirstConfig = {
            ...this.config.fileFirstConfig,
            write: async (path: string, content: string) => {
              try {
                await storage.writeFile(path, Buffer.from(content, 'utf-8'));
                return true;
              } catch {
                return false;
              }
            },
          };
          const offloaded = await offloadToolResult(
            output,
            params.toolCallId,
            writeConfig,
            toolModel.skipOffload,
          );
          if (offloaded) {
            logger.info(`[AgentService] Tool result offloaded`, {
              toolName: params.toolName,
              toolCallId: params.toolCallId,
              filePath: offloaded.filePath,
              originalLength: output.length,
            });
            output = offloaded.compactReference;
          }
        }

        const isBinary = isBinaryToolOutput(output);
        const limit = toolModel.outputCharLimit ?? DEFAULT_TOOL_OUTPUT_CHAR_LIMIT;
        const limitedOutput = isBinary
          ? output
          : applyToolOutputCharLimit(output, limit, params.toolName);
        const originalLength = typeof output === 'string' ? output.length : undefined;
        const capped = originalLength !== undefined && originalLength > limit;

        let logOutput: string;
        if (isBinaryToolOutput(output)) {
          logOutput = `[binary ${output.type}]`;
        } else if (typeof limitedOutput === 'string') {
          logOutput = limitedOutput;
        } else {
          logOutput = JSON.stringify(limitedOutput);
        }

        logger.info(`[AgentService] Tool execute END`, {
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          output: logOutput,
          originalLength,
          capped,
        });

        // Emit output-available state (output not sent - model-only, UI uses props).
        // fallbackText stays uncapped (only the LLM-visible value is capped)
        // and derives from fallbackMarkdown when supplied — for such tools the
        // output is a status line, not the content.
        let fallbackText: string | undefined;
        if (result.fallbackMarkdown !== undefined) {
          fallbackText = plainTextFromMarkdown(result.fallbackMarkdown);
        } else if (typeof result.output === 'string') {
          fallbackText = result.output;
        }
        this.emitStreamingComponent(ui, params.toolCallId, params.toolName, 'output-available', {
          input,
          inputDelta: accumulatedDelta,
          props: result.uiProps,
          fallbackText,
          fallbackMarkdown: result.fallbackMarkdown,
          progress: result.progress,
        });

        // Cleanup
        this.toolPartDeltas.delete(params.toolCallId);

        return limitedOutput;
      } catch (error) {
        // Emit output-error state
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[AgentService] Tool execute ERROR`, {
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.emitStreamingComponent(ui, params.toolCallId, params.toolName, 'output-error', {
          input,
          inputDelta: accumulatedDelta,
          error: errorMessage,
          fallbackText: `Error: ${errorMessage}`,
        });

        // Cleanup
        this.toolPartDeltas.delete(params.toolCallId);

        throw error;
      }
    };

    let handle: AgentRunnerHandle | undefined;
    let traceRun: TraceRun | undefined;
    let eventCount = 0;
    const stepUsages: StepUsage[] = [];

    let stepProducedOutput = false;
    let finalStepEnded = false;
    let finalStepProducedOutput = false;
    let finalStepUsage: LanguageModelUsage | undefined;

    const appContext = this.getTraceContextFromApp();
    const traceOrchestrator = this.traceOrchestrator ?? getLangfuseTraceOrchestrator();
    if (!traceOrchestrator) {
      logger.debug('[AgentService] Trace orchestrator is not configured');
    }

    try {
      const traceName = this.config.state.getTraceConfig()?.name ?? 'Agent';
      traceRun = traceOrchestrator?.startRun({
        traceName,
        input: options.messages,
        userId: appContext?.userId,
        agentId: appContext?.agentId,
        sessionId: this.config.sessionId,
        requestId: appContext?.requestId,
        metadata: {
          responseId: this.config.state.getResponseId(),
        },
        model: this.config.state.getModelId(),
        provider: this.config.state.getProvider(),
        modelParameters: options.modelSettings,
      });
      if (traceRun?.traceId) {
        try {
          this.config.state.setTraceId(traceRun.traceId);
        } catch (error) {
          logger.warn('[AgentService] Failed to store traceId', { error });
        }
      }

      handle = await this.runner.runStream({
        model: options.model,
        instructions: options.instructions,
        messages: options.messages,
        tools: toolDefinitions,
        aiSdkToolset,
        stopAtToolNames: options.stopAtToolNames,
        maxSteps: options.maxSteps ?? 20,
        abortSignal: this.abortController.signal,
        executeTool,
        appState: this.config.state,
        onStepMessages: (stepMessages) => {
          this.config.state.setStepMessages(stepMessages);
        },
        structuredOutputSchema: options.structuredOutputSchema,
        modelSettings: options.modelSettings,
        prepareStep: options.prepareStep,
        stopWhen: options.stopWhen,
      });

      if (handle?.traceId) {
        try {
          this.config.state.setTraceId(handle.traceId);
        } catch (error) {
          logger.warn('[AgentService] Failed to store traceId', { error });
        }
      }

      for await (const ev of handle.events) {
        eventCount++;
        // Forward raw event to eventSink (for transport/WebSocket)
        eventSink?.append(ev);

        if (ui.isEnded()) {
          aborted = true;
          this.abortController.abort();
          break;
        }
        if (ev.type === 'stream-error') {
          streamError = ev.error;
          break;
        }
        if (ev.type === 'model-step-start') {
          // Reset here, not on step end, so a step that begins and never ends
          // cannot leave the previous step's verdict standing.
          stepProducedOutput = false;
          finalStepEnded = false;
          finalStepUsage = undefined;
          this.#agui?.emit(aguiEvent.stepStarted(ev.stepIndex));
          const finalPrompt = this.config.state.getLastFinalPrompt?.();
          traceRun?.onModelStepStart({
            stepIndex: ev.stepIndex,
            input: finalPrompt ?? options.messages,
            model: this.config.state.getModelId(),
            provider: this.config.state.getProvider(),
            modelParameters: options.modelSettings,
          });
        }
        if (
          ev.type === 'text-delta' ||
          ev.type === 'reasoning-delta' ||
          ev.type === 'tool-input-start' ||
          ev.type === 'tool-call' ||
          ev.type === 'source'
        ) {
          stepProducedOutput = true;
        }
        if (ev.type === 'model-step-end') {
          finalStepEnded = true;
          finalStepProducedOutput = stepProducedOutput;
          finalStepUsage = ev.usage;
          this.#agui?.emit(aguiEvent.stepFinished(ev.stepIndex));
          traceRun?.onModelStepEnd({
            stepIndex: ev.stepIndex,
            output: this.config.state.getStepMessages(),
            usage: ev.usage,
          });

          // Log usage info after each LLM call
          if (ev.usage) {
            stepUsages.push({ stepIndex: ev.stepIndex, usage: ev.usage });
            logger.info('[AgentService] LLM call usage:', {
              stepIndex: ev.stepIndex,
              usage: ev.usage,
            });
          }
        }
        if (ev.type === 'tool-call' && stopAt && stopAt.has(ev.toolName)) {
          stoppedByToolName = ev.toolName;
        }
        if (ev.type === 'tool-call') {
          traceRun?.onToolStart({
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            input: ev.input,
          });
        }
        if (ev.type === 'tool-result') {
          traceRun?.onToolEnd({
            toolCallId: ev.toolCallId,
            output: ev.output,
          });
        }
        if (ev.type === 'tool-error') {
          traceRun?.onToolEnd({
            toolCallId: ev.toolCallId,
            error: ev.error,
          });
        }
        this.handleEvent(ev, ui);
        if (ev.type === 'model-step-end') {
          this.config.state.emitContent(ui.takeFinalized());
        }
        if (ev.type === 'tool-result' || ev.type === 'tool-error') {
          this.config.state.emitContent(ui.takeFinalized());
        }
        if (ev.type === 'finish') {
          stopReason = ev.stopReason;
          finishReason = ev.finishReason;
          break;
        }
      }
    } catch (error) {
      streamError = error;
    } finally {
      logger.info('[AgentService] Event loop exited', { eventCount });
      logger.info('[AgentService] Awaiting runner done promise');
      const doneInfo = await handle?.done;
      structuredOutput = doneInfo?.structuredOutput;
      logger.info('[AgentService] Runner done resolved', { stopReason, finishReason });

      this.config.state.emitContent(ui.takeAll());
      ui.endStream();
      // NOTE: eventSink is run-scoped (created once per `Agent.run()`, drained
      // across every retry turn in `Agent.callAgent`'s while-loop). Ending it
      // here would close the sink after the first turn and silently drop
      // events from subsequent turns — observed as ~37% of builder LLM calls
      // missing from usage capture when a run hits a retryable stream error.
      // The run-level close happens in `Agent.stopProcessing`.
    }

    this.config.state.commitPendingStepInjections();
    this.config.state.commitStepMessages();

    const history = this.config.state.getConversationHistory();

    if (finishReason && finishReason !== 'stop' && finishReason !== 'tool-calls') {
      logger.info('[AgentService] Non-standard finish reason', { finishReason });
    }

    if (streamError) {
      logAgentError('[AgentService] Stream error', streamError);
      this.#agui?.emit(aguiEvent.runError(streamError));
      traceRun?.onRunEnd({
        status: 'error',
        error: streamError,
        conversationHistory: history,
      });
      await traceRun?.flush?.();
      return { status: 'error', history, error: streamError };
    }
    if (aborted) {
      this.#agui?.emit(aguiEvent.runFinished({ status: 'aborted' }));
      traceRun?.onRunEnd({ status: 'aborted', conversationHistory: history });
      await traceRun?.flush?.();
      return { status: 'aborted', history };
    }
    this.#agui?.emit(aguiEvent.runFinished({ status: 'ok', stoppedByToolName }));
    traceRun?.onRunEnd({
      status: 'ok',
      output: structuredOutput ?? history,
      conversationHistory: history,
    });
    await traceRun?.flush?.();
    const steps = stepUsages.length > 0 ? stepUsages : undefined;
    const finalStepEmpty =
      finalStepEnded && !finalStepProducedOutput && !finalStepUsage?.outputTokens;
    const finalStepReportedZeroOutput =
      finalStepEnded && !finalStepProducedOutput && finalStepUsage?.outputTokens === 0;
    return {
      status: 'ok',
      history,
      structuredOutput,
      stopReason,
      finishReason,
      steps,
      finalStepEmpty,
      finalStepReportedZeroOutput,
      ...(stoppedByToolName ? { stoppedByToolName } : {}),
    };
  }

  private getTraceContextFromApp(): {
    userId?: string;
    agentId?: string;
    requestId?: string;
  } | null {
    const app = this.config.state.getApp<unknown>();
    if (!app || typeof app !== 'object' || Array.isArray(app)) {
      return null;
    }
    const record = app as Record<string, unknown>;
    const userId = typeof record.userId === 'string' ? record.userId : undefined;
    const agentId = typeof record.agentId === 'string' ? record.agentId : undefined;
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
    if (!userId && !agentId && !requestId) {
      return null;
    }
    return { userId, agentId, requestId };
  }

  private buildToolModelMap(): void {
    this.toolModelMap.clear();
    for (const toolModel of this.config.toolRegistry.getAllTools()) {
      this.toolModelMap.set(toolModel.getName(), toolModel as ToolModel<unknown>);
    }
  }

  private handleEvent(event: AgentStreamEvent, contentStream: UiSink): void {
    if (event.type === 'stream-error') {
      return;
    }
    if (event.type === 'model-step-start') {
      // Defensive: a previous step that ended abnormally may have left
      // sources buffered. Clear so they don't bleed into this step's
      // citations block.
      this.currentStepSources.clear();
      return;
    }
    if (event.type === 'model-step-end') {
      this.flushStepSources(contentStream);
      return;
    }
    if (event.type === 'source') {
      this.handleSource(event);
      return;
    }
    if (event.type === 'text-delta') {
      this.handleTextDelta(event.messageId, event.textDelta, contentStream, false);
      return;
    }
    if (event.type === 'reasoning-delta') {
      this.handleTextDelta(event.messageId, event.textDelta, contentStream, true);
      return;
    }
    if (event.type === 'tool-input-start') {
      this.tempIdForText = null;
      this.tempIdForReasoning = null;
      this.handleToolInputStart(event.toolCallId, event.toolName, contentStream);
      return;
    }
    if (event.type === 'tool-input-delta') {
      this.handleToolInputDelta(event.toolCallId, event.delta, contentStream);
      return;
    }
    if (event.type === 'tool-input-end') {
      this.handleToolInputEnd(event.toolCallId, contentStream);
      return;
    }
    if (event.type === 'tool-call') {
      this.dispatchToolRunnerEvent(
        {
          type: 'tool-call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        },
        contentStream,
      );
      return;
    }
    if (event.type === 'tool-result') {
      this.dispatchToolRunnerEvent(
        {
          type: 'tool-result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
        },
        contentStream,
      );
      return;
    }
    if (event.type === 'tool-error') {
      this.dispatchToolRunnerEvent(
        {
          type: 'tool-error',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          error: event.error,
        },
        contentStream,
      );
      return;
    }
    if (event.type === 'finish') {
      return;
    }
  }

  private handleTextDelta(
    messageIdFromRunner: string | undefined,
    delta: string,
    _contentStream: UiSink,
    isReasoning: boolean,
  ): void {
    let messageId = messageIdFromRunner;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      const temp = isReasoning ? this.tempIdForReasoning : this.tempIdForText;
      if (temp) {
        messageId = temp;
      } else {
        messageId = generateShortId(8);
        if (isReasoning) {
          this.tempIdForReasoning = messageId;
        } else {
          this.tempIdForText = messageId;
        }
      }
    }

    if (isReasoning) {
      this.#agui?.emit(aguiEvent.reasoningChunk({ messageId, delta }));
    } else {
      this.#agui?.emit(aguiEvent.textChunk({ messageId, delta }));
    }
  }

  /** Track current tool name for each tool call (needed for ToolPart emission) */
  private toolCallNames: Map<string, string> = new Map();

  private handleToolInputStart(callId: string, toolName: string, contentStream: UiSink): void {
    // Track tool name for this call
    this.toolCallNames.set(callId, toolName);

    // ToolPart-only: emit input-streaming state
    this.toolPartDeltas.set(callId, '');
    this.#visibleToolInputComponents.delete(callId);
    this.emitStreamingComponent(contentStream, callId, toolName, 'input-streaming', {
      inputDelta: '',
    });
    const componentName = this.toolModelMap.get(toolName)?.getComponentName(callId);
    if (componentName) {
      this.#visibleToolInputComponents.set(callId, componentName);
    }
  }

  private handleToolInputDelta(callId: string, delta: string, contentStream: UiSink): void {
    const toolName = this.toolCallNames.get(callId);

    if (!toolName) {
      return;
    }

    // Accumulate delta and emit ToolPart
    const currentDelta = this.toolPartDeltas.get(callId) || '';
    const newDelta = currentDelta + delta;
    this.toolPartDeltas.set(callId, newDelta);

    const componentName = this.toolModelMap.get(toolName)?.getComponentName(callId);
    const previousComponentName = this.#visibleToolInputComponents.get(callId);
    const visibleDelta =
      componentName && componentName !== previousComponentName ? newDelta : delta;

    this.emitStreamingComponent(contentStream, callId, toolName, 'input-streaming', {
      inputDelta: visibleDelta,
    });
    if (componentName) {
      this.#visibleToolInputComponents.set(callId, componentName);
    }

    this.maybeStreamPartialInput(callId, toolName, newDelta);
  }

  private handleToolInputEnd(callId: string, _contentStream: UiSink): void {
    this.toolCallNames.delete(callId);
    this.#visibleToolInputComponents.delete(callId);
  }

  /**
   * Best-effort progressive UI hook: parses the accumulated tool-input
   * buffer and calls `ToolModel.streamPartialInput` when the tool defines
   * it and has not opted out via `wantsPartialInput === false`, on every
   * delta. Never gated on `isStreaming` — that flag controls
   * the unrelated per-delta ComponentContent emission (see tool-model.ts).
   * Event-spam protection lives downstream — the tool's own hook is
   * expected to dedupe by content before emitting. Any failure here
   * (malformed partial JSON, a throwing hook) is caught and logged — it
   * must never break the run.
   */
  private maybeStreamPartialInput(callId: string, toolName: string, accumulated: string): void {
    const tool = this.toolModelMap.get(toolName);
    if (!tool?.streamPartialInput || tool.wantsPartialInput === false) {
      return;
    }

    try {
      const content = createStreamingComponent({
        messageId: callId,
        componentName: tool.getComponentName(callId) ?? toolName,
        toolName,
        toolCallId: callId,
        inputDelta: accumulated,
      });
      const { streamingInput } = this.#componentPropsResolver.resolve(content);
      const emit = (name: string, value: unknown): void => {
        this.#agui?.emit(aguiEvent.custom(name, value));
      };
      tool.streamPartialInput(streamingInput, emit, { toolCallId: callId });
    } catch (error) {
      logger.warn('[AgentService] streamPartialInput hook failed — ignoring', {
        toolName,
        toolCallId: callId,
        error: normalizeError(error),
      });
    }
  }

  /**
   * Accumulate a provider-grounding source for the current step. Dedupes
   * by URL (or title for sourceless entries) — providers may emit the same
   * citation more than once when the model references it multiple times.
   */
  private handleSource(event: AgentStreamEvent & { type: 'source' }): void {
    const url = typeof event.url === 'string' && event.url.length > 0 ? event.url : undefined;
    const title =
      typeof event.title === 'string' && event.title.length > 0 ? event.title : undefined;
    if (!url && !title) {
      return;
    }
    const key = url ?? `title:${title}`;
    if (this.currentStepSources.has(key)) {
      return;
    }
    this.currentStepSources.set(key, { url, title });
  }

  /**
   * Emit a `Sources` UI component carrying the citations collected during
   * the current step, then clear the buffer. No-op when no sources were
   * gathered. Channels without a `Sources` renderer fall back to the
   * markdown text we attach via `fallbackMarkdown`.
   */
  private flushStepSources(_contentStream: UiSink): void {
    if (this.currentStepSources.size === 0) {
      return;
    }
    const sources = Array.from(this.currentStepSources.values());
    this.currentStepSources.clear();
    const fallbackMarkdown = sources
      .map((s) => (s.title && s.url ? `- [${s.title}](${s.url})` : `- ${s.title ?? s.url}`))
      .join('\n');
    this.#agui?.emit(
      aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.sources, {
        messageId: generateShortId(8),
        sources,
        fallbackMarkdown,
      }),
    );
  }

  /**
   * Dispatch runner tool events to tool models.
   *
   * This is required for provider-native tools (executed by the provider/AI SDK)
   * and any tool implementations that choose to render UI directly from runner events.
   */
  private dispatchToolRunnerEvent(event: ToolRunnerEvent, contentStream: UiSink): void {
    const toolModel = this.toolModelMap.get(event.toolName);
    if (!toolModel) {
      return;
    }

    const rawArgs =
      event.type === 'tool-call'
        ? JSON.stringify(event.input ?? {})
        : event.type === 'tool-result'
          ? '[tool-result]'
          : JSON.stringify(event.error ?? {});

    const toolInvocationContext: ToolInvocationContext<AgentState> = {
      runner: {
        state: this.config.state,
        abortSignal: this.abortController.signal,
      },
      toolCall: {
        callId: event.toolCallId,
        toolName: event.toolName,
        rawArgs,
        parsedArgs:
          event.type === 'tool-call'
            ? event.input
            : event.type === 'tool-result'
              ? event.output
              : event.error,
        metadata: {},
      },
    };

    // Tool models append AgentContent directly. Wrap losslessly so those items
    // ride the native stream via a CUSTOM envelope (native mapping is a later
    // wire-plan concern; the projector unwraps `agentplace.content` verbatim).
    const envelopeSink: UiSink = {
      isEnded: () => contentStream.isEnded(),
      endStream: () => contentStream.endStream(),
      append: (content) => {
        this.#agui?.emit(aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.content, { content }));
      },
    };
    toolModel.onRunnerToolEvent(event, envelopeSink, toolInvocationContext);
  }
}
