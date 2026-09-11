import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { StepResult, StopCondition, ToolSet } from 'ai';
import type { AgentMode } from '../types/mode.ts';
import type { IToolRegistry } from '../tools/tool-registry.ts';
import type { KernelModelMiddleware } from '../kernel/middlewares/index.ts';
import type { TurnProcessor } from '../kernel/processors/types.ts';
import type AgentState from './agent-state.ts';
import type { AgentTurnRequest } from './agent-state.ts';
import type { SessionManager } from '../sessions/session-manager.ts';
import type { AgentKernelEventSink } from '../kernel/events.ts';
import type { FileFirstConfig } from './file-first-offloader.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';
import type { LlmErrorCode } from '../types/errors.ts';

/**
 * Per-step hook called before each model call in the tool loop. Can return
 * either:
 *  - `messages` — replaces the default message array for that step.
 *  - `providerOptions` — merged (deep) into the call's `providerOptions`
 *    before the request goes out, so the callback can thread per-step
 *    provider state (e.g. Anthropic container IDs via
 *    `forwardAnthropicContainerIdFromLastStep`) without touching the static
 *    `modelSettings.providerOptions`.
 *
 * `steps` is the array of previously-completed steps in this run — included
 * so callbacks can read state from prior responses (the AI SDK helpers above
 * iterate over it). Treat it as opaque; only forward fields you understand.
 */
export type PrepareStepCallback = (args: {
  stepNumber: number;
  messages: ModelMessage[];
  /**
   * Mutable array shape mirrors AI SDK's `PrepareStepFunction.steps` so
   * helpers like `forwardAnthropicContainerIdFromLastStep` (typed against
   * `Array<{ providerMetadata? }>`) accept it without a cast.
   */
  steps?: StepResult<ToolSet>[];
}) =>
  | { messages?: ModelMessage[]; providerOptions?: ProviderOptions }
  | undefined
  | Promise<{ messages?: ModelMessage[]; providerOptions?: ProviderOptions } | undefined>;

export type Attachment = {
  type: string;
  name: string;
  data: string;
  updateTms: number;
  description?: string;
  url?: string;
};

export interface CreateAgentParams {
  agentMode?: AgentMode;
  systemInstruction?: string;
  limits?: {
    maxTurns?: number;
    maxModelCalls?: number;
    maxRetries?: number;
    maxContinuations?: number;
  };
  toolRegistry?: IToolRegistry;
  model?: LanguageModelV3;
  modelSettings?: {
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
  };
  modelMiddlewares?: KernelModelMiddleware[];
  processors?: TurnProcessor[];
  /**
   * Initial agent state. Pass either a plain `AgentTurnRequest` (the factory calls
   * `AgentState.createTurn()` internally) or a pre-created `AgentState` instance
   * (used directly as-is, so the same instance can be closed over by `prepareStep`
   * / `stopWhen` callbacks without a forward-reference workaround).
   */
  state?: AgentTurnRequest | AgentState;
  /** Trace name for observability. */
  traceName?: string;
  /** Session manager for automatic conversation persistence. */
  sessionManager?: SessionManager;
  /** Per-step hook — called before each model call in the tool loop. Can modify messages. */
  prepareStep?: PrepareStepCallback;
  /** User-supplied stop condition(s). Merged with the default `stepCountIs(maxSteps)` and any `stopAtToolNames` predicates. AI SDK treats an array as OR. */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /**
   * Timeout in milliseconds for receiving the first token from the model.
   * If the model does not produce any output within this time, the call is aborted and retried.
   */
  firstTokenTimeoutMs?: number;
  /** Event sink for kernel-level events (error, retry, turn lifecycle). */
  onEvent?: AgentKernelEventSink;
  /** Host-owned stable wording for terminal error codes. */
  resolveUserMessage?: (code: LlmErrorCode, state: AgentState) => string | undefined;
  /** File-first offloading config. When set, large tool results are written to disk. */
  fileFirstConfig?: FileFirstConfig;
  /** AgentStorage for file-first offloading and unified data access */
  agentStorage?: AgentStorage;
  /**
   * Optional host hook: map a terminal (non-retryable) error to a UI component
   * to render instead of the default text message, then stop the run. Returns
   * `null` to fall back to the default error handling. Keeps the library
   * UI-agnostic — the host owns the component name and props (e.g. a billing
   * paywall on credit exhaustion). Consulted before the retry policy, so a
   * mapped error is always terminal and never retried.
   */
  resolveTerminalErrorComponent?: TerminalErrorResolver;
}

/** A UI component to render for a terminal error: see {@link TerminalErrorResolver}. */
export type TerminalErrorComponent = {
  componentName: string;
  props: Record<string, unknown>;
};

export type TerminalErrorResolver = (error: unknown) => TerminalErrorComponent | null;

export interface IAgentState<TAppContext = unknown> {
  getAppContext(): TAppContext | null;
  setError(error: Error | null): void;
  getError(): Error | null;
  increaseModelCallsCount(): void;
  getModelCallsCount(): number;
  increaseRetriesCount(): void;
  getRetriesCount(): number;
  getRemindersCount(): number;
  getModelId(): string | null;
  setModelId(modelId: string | null): void;
  getProvider(): string | null;
  setProvider(provider: string | null): void;
  getAttachments(): Attachment[];
  getConversationHistory(): ModelMessage[];
  setStepMessages(stepMessages: ModelMessage[]): void;
  /**
   * Commit the buffered step messages into the kernel-owned conversation history.
   */
  commitStepMessages(): void;
  setPendingStepInjections(injections: { position: number; message: ModelMessage }[]): void;
  commitPendingStepInjections(): void;
  setConversationHistory(conversationHistory: ModelMessage[]): void;
  hasConversationHistory(): boolean;
}
