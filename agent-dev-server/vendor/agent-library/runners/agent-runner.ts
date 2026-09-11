/**
 * AgentRunner
 *
 * Framework seam between `AgentService` and nothing more for now
 *
 * Requirements for implementations:
 * - expose an async stream of `AgentStreamEvent` events
 * - provide a `done` promise that settles when streaming is complete
 * - never depend on `ActionAgent` / UI types; emit only `AgentStreamEvent`
 *
 * `AgentService` owns turning these events into UI stream content and executing server tools.
 */
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelMessage, ProviderOptions } from '@ai-sdk/provider-utils';
import type { ToolDefinition } from '../kernel';
import type { StopCondition, Tool, ToolSet } from 'ai';
import type { ZodType } from 'zod';
import type AgentState from '../core/agent-state';
import type { PrepareStepCallback } from '../core/interfaces';

/**
 * Unified finish reason from the AI SDK model response.
 * - 'stop': model completed naturally
 * - 'length': hit maxOutputTokens (response truncated)
 * - 'tool-calls': model invoked tool(s)
 * - 'content-filter': blocked by safety filter
 * - 'error': internal model error
 * - 'other': unknown/provider-specific reason
 */
export type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

export type AgentStreamEvent =
  | { type: 'text-delta'; messageId: string; textDelta: string }
  | { type: 'reasoning-delta'; messageId: string; textDelta: string }
  | { type: 'model-step-start'; stepIndex: number }
  | {
      type: 'model-step-end';
      stepIndex: number;
      usage?: import('ai').LanguageModelUsage;
      finishReason?: FinishReason;
      /**
       * Provider-specific metadata blob (Anthropic `server_tool_use`,
       * Vertex `groundingMetadata`, Bedrock Nova counters, etc.). AI SDK
       * normalises `usage` to a generic token-only shape and splits the
       * provider-specific signals onto this field — billing/cost capture
       * needs both. Keyed by AI SDK provider id (`anthropic`, `google`,
       * `bedrock`, …) per AI SDK's `providerMetadata` contract.
       */
      providerMetadata?: Record<string, Record<string, unknown>>;
    }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; delta: string }
  | { type: 'tool-input-end'; toolCallId: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: unknown }
  /**
   * Inline source surfaced by a provider's grounding tool (e.g. Vertex
   * `googleSearch`, OpenAI URL annotations, Bedrock Nova citations).
   * Emitted during a step BEFORE that step's `model-step-end`. Consumers
   * typically accumulate sources per step and render a citations footer
   * — these are response-level grounding signals, not discrete tool calls.
   */
  | {
      type: 'source';
      sourceId: string;
      sourceType: 'url' | 'document';
      url?: string;
      title?: string;
    }
  | { type: 'stream-error'; error: unknown }
  | { type: 'finish'; stopReason?: 'max-steps'; finishReason?: FinishReason };

export type AgentRunnerToolExecutor = (params: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  rawArgs: string;
}) => Promise<unknown>;

export interface AgentRunnerRunOptions {
  model: LanguageModelV3;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /**
   * Provider-native AI SDK tools (e.g. Anthropic text editor / web search).
   *
   * Important: AI SDK tools do not carry a `name` property; the tool name is the key in this record.
   */
  aiSdkToolset?: Record<string, Tool<unknown, unknown>>;
  /**
   * @deprecated Prefer `aiSdkToolset` so tool names are not lost.
   */
  aiSdkTools?: Array<Tool<unknown, unknown>>;
  stopAtToolNames?: string[];
  maxSteps: number;
  abortSignal: AbortSignal;
  executeTool: AgentRunnerToolExecutor;
  onEnd?: () => void;
  onStepMessages?: (stepMessages: ModelMessage[]) => void;
  structuredOutputSchema?: ZodType<unknown>;
  modelSettings?: {
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
  };
  /**
   * Kernel/application state for this run. The runner may attach framework-specific
   * internal state to it
   */
  appState: AgentState;
  /** Per-step hook — called before each model call in the tool loop. Can modify messages. */
  prepareStep?: PrepareStepCallback;
  /** User-supplied stop condition(s). Merged with default `stepCountIs(maxSteps)` and `stopAtToolNames`. */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
}

export interface AgentRunnerHandle {
  events: AsyncIterable<AgentStreamEvent>;
  done: Promise<{
    structuredOutput?: unknown;
  }>;
  /**
   * Root trace id for this run (when tracing is enabled).
   */
  traceId?: string;
}

export interface AgentRunner {
  runStream(options: AgentRunnerRunOptions): Promise<AgentRunnerHandle>;
}
