/**
 * Agent Content Types
 *
 * Canonical content types for the agent runtime.
 * These are plain objects (not classes) for better portability and JSON serialization.
 */

import type { LlmErrorCode } from './errors.ts';
import type { ToolOutput } from './tool-output.ts';

export const ContentType = {
  Text: 'TXT',
  Audio: 'audio',
  Tool: 'Tool',
  Component: 'Component',
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/**
 * A committed, user-relevant fact about work that is still running.
 *
 * Producers author the fact; channel adapters may decide whether and how to
 * present it. Tool names, elapsed time, reasoning, and raw UI props are not
 * progress facts and must never be inferred into this contract.
 */
export interface UserFacingProgress {
  text: string;
}

/**
 * Streaming state machine for tool components.
 * Represents the lifecycle of a tool invocation.
 */
export type ToolPartState =
  | 'input-streaming' // LLM is generating tool arguments
  | 'input-available' // Arguments complete, ready to execute
  | 'output-pending' // Tool is executing
  | 'output-available' // Execution complete, success
  | 'output-error'; // Execution failed

export interface AgentContentBase {
  messageId: string;
  responseId?: string;
  type: ContentType;
  /** Message role - 'user' for user messages, undefined for agent messages */
  role?: 'user';
  /** When true, this content is part of the conversation but should not be rendered in chat UI */
  hidden?: boolean;
  /**
   * Originating input or delivery channel, e.g. `'voice'` for a spoken user
   * turn or assistant delivery. Undefined for ordinary typed content.
   * Persisted by SessionManager so restored content retains its provenance.
   */
  channel?: string;
  /** Delivery evidence for speech rendered from this content. */
  voiceDelivery?: {
    kind: string;
    status: 'full' | 'partial' | 'unconfirmed';
    runId?: string;
    audioEndMs?: number;
  };
  /** Optional semantic progress carried by this ordinary content event. */
  progress?: UserFacingProgress;
}

export interface TextContent extends AgentContentBase {
  type: typeof ContentType.Text;
  content: string;
  /** Machine-readable LLM error category when this text is a terminal error message. */
  errorCode?: LlmErrorCode;
  isReasoning?: boolean;
}

export interface AudioContent extends AgentContentBase {
  type: typeof ContentType.Audio;
  content: {
    data: string;
    text?: string;
  };
}

export interface ToolContent extends AgentContentBase {
  type: typeof ContentType.Tool;
  tool: {
    name: string;
  };
  /** Tool output props — the tool's `uiProps` from its execute result. */
  content: unknown;
  /**
   * Lifecycle metadata for non-UI tools. Emitted at key states so inner-agent
   * observers (subagent counter, deep-research source extractor) can track
   * execution without going through the Component channel.
   */
  streaming?: {
    toolName: string;
    toolCallId: string;
    state: ToolPartState;
    input?: Record<string, unknown>;
  };
}

/**
 * Streaming state for tool components.
 * Only present for components that go through the tool execution lifecycle.
 */
export interface ComponentStreaming {
  /** Tool name (for identification) */
  toolName: string;

  /** Tool call ID from LLM */
  toolCallId: string;

  /** Current state in lifecycle */
  state: ToolPartState;

  /** Accumulated input delta (during input-streaming) */
  inputDelta?: string;

  /** Parsed tool arguments (after input-available) */
  input?: Record<string, unknown>;

  /**
   * Tool execution result.
   * @deprecated Output is no longer sent to UI to avoid large payloads.
   * Use `props` (from uiProps) for UI-specific data instead.
   * The model receives output via toModelOutput in the runner.
   */
  output?: ToolOutput;

  /** Error message (after output-error) */
  error?: string;
}

/**
 * Unified component content.
 *
 * Used for both simple UI components and streaming tool components.
 * - Simple UI: Just componentName + props
 * - Streaming tool: componentName + props + streaming
 *
 * @example
 * ```typescript
 * // Simple UI (paywall, notification, etc.)
 * createComponent({
 *   messageId,
 *   componentName: 'BuilderPaywall',
 *   props: { reason: 'limit_reached' },
 * });
 *
 * // Streaming tool
 * createComponent({
 *   messageId,
 *   componentName: 'UpdateFile',
 *   props: { path: 'src/Button.tsx' },
 *   streaming: {
 *     toolName: 'UpdateFile',
 *     toolCallId: 'call_123',
 *     state: 'input-streaming',
 *     inputDelta: '{"path":"...',
 *   },
 * });
 * ```
 */
export interface ComponentContent extends AgentContentBase {
  type: typeof ContentType.Component;

  /** UI component name to render */
  componentName: string;

  /** Props for rendering (always available) */
  props: Record<string, unknown>;

  /**
   * Streaming tool lifecycle (optional).
   * Only present for tools with input streaming + execution.
   */
  streaming?: ComponentStreaming;

  /**
   * Plain-text representation of the component, used by channels that have
   * no renderer for `componentName` AND no markdown support (e.g. SMS,
   * voice transcripts). Also flows to the LLM as the tool's `output`.
   * Derived from the contract-materialized `fallbackMarkdown`.
   */
  fallbackText?: string;

  /**
   * Markdown representation of the component, used by markdown-aware
   * channels (web, Discord, Slack, email) when they have no native renderer
   * for `componentName`. The component contract authors `fallbackTemplate`
   * once; rendering evaluates it with validated props to materialize this
   * surface-specific value. Contracts without a template receive the generic
   * deterministic fallback produced by the render kernel.
   */
  fallbackMarkdown?: string;
}

/**
 * @deprecated Use ComponentContent with streaming field instead.
 * Kept for backward compatibility with persisted data.
 */
/**
 * Props passed to component UI for rendering.
 *
 * @example
 * ```tsx
 * function UpdateFile({ component }: { component: ComponentProps }) {
 *   const { isStreaming, isLoading, isDone } = component;
 *
 *   if (isStreaming) return <StreamingPreview delta={component.streaming?.inputDelta} />;
 *   if (isLoading) return <Shimmer />;
 *   if (isDone) return <FilePreview {...component.props} />;
 * }
 * ```
 */
export interface ComponentProps<
  TProps = Record<string, unknown>,
  TInput = Record<string, unknown>,
> {
  componentName: string;
  props: TProps;
  streaming?: ComponentStreaming;

  // Derived state helpers
  isStreaming: boolean;
  isLoading: boolean;
  isDone: boolean;
  hasError: boolean;

  // Convenience accessors
  input?: TInput;
  output?: ToolOutput;
  error?: string;
}

/**
 * Transform ComponentContent to ComponentProps for UI rendering.
 */
export function toComponentProps<
  TProps = Record<string, unknown>,
  TInput = Record<string, unknown>,
>(content: ComponentContent): ComponentProps<TProps, TInput> {
  const s = content.streaming;
  return {
    componentName: content.componentName,
    props: content.props as TProps,
    streaming: s,

    // Derived state
    isStreaming: s?.state === 'input-streaming',
    isLoading: s?.state === 'input-available' || s?.state === 'output-pending',
    isDone: !s || s.state === 'output-available' || s.state === 'output-error',
    hasError: s?.state === 'output-error',

    // Convenience accessors
    input: s?.input as TInput | undefined,
    output: s?.output,
    error: s?.error,
  };
}

/**
 * Check if component is in a loading state.
 */
export function isComponentLoading(content: ComponentContent): boolean {
  const state = content.streaming?.state;
  return state === 'input-available' || state === 'output-pending';
}

/**
 * Check if component is streaming input.
 */
export function isComponentStreaming(content: ComponentContent): boolean {
  return content.streaming?.state === 'input-streaming';
}

/**
 * Check if component is done (no streaming, or streaming complete).
 */
export function isComponentDone(content: ComponentContent): boolean {
  const s = content.streaming;
  return !s || s.state === 'output-available' || s.state === 'output-error';
}

export type AgentContent = TextContent | AudioContent | ToolContent | ComponentContent;

// ============================================================================
// Factory Functions
// ============================================================================

export function createTextContent(params: {
  messageId: string;
  responseId?: string;
  content: string;
  isReasoning?: boolean;
  role?: 'user';
  hidden?: boolean;
  channel?: string;
  voiceDelivery?: AgentContentBase['voiceDelivery'];
  progress?: UserFacingProgress;
  errorCode?: LlmErrorCode;
}): TextContent {
  return {
    type: ContentType.Text,
    messageId: params.messageId,
    responseId: params.responseId,
    content: params.content,
    isReasoning: params.isReasoning,
    role: params.role,
    hidden: params.hidden,
    channel: params.channel,
    voiceDelivery: params.voiceDelivery,
    progress: params.progress,
    errorCode: params.errorCode,
  };
}

export function createAudioContent(params: {
  messageId: string;
  responseId?: string;
  content: { data: string; text?: string };
  role?: 'user';
}): AudioContent {
  return {
    type: ContentType.Audio,
    messageId: params.messageId,
    responseId: params.responseId,
    content: params.content,
    role: params.role,
  };
}

export function createToolContent(params: {
  messageId: string;
  responseId?: string;
  tool: { name: string };
  content: unknown;
  streaming?: ToolContent['streaming'];
  progress?: UserFacingProgress;
}): ToolContent {
  return {
    type: ContentType.Tool,
    messageId: params.messageId,
    responseId: params.responseId,
    tool: params.tool,
    content: params.content,
    streaming: params.streaming,
    progress: params.progress,
  };
}

/**
 * Create a component content.
 *
 * @example
 * ```typescript
 * // Simple UI
 * createComponent({
 *   messageId,
 *   componentName: 'BuilderPaywall',
 * });
 *
 * // With props
 * createComponent({
 *   messageId,
 *   componentName: 'Notification',
 *   props: { message: 'Hello' },
 * });
 *
 * // Streaming tool
 * createComponent({
 *   messageId,
 *   componentName: 'UpdateFile',
 *   props: { path: 'src/foo.ts' },
 *   streaming: {
 *     toolName: 'UpdateFile',
 *     toolCallId: 'call_123',
 *     state: 'input-streaming',
 *   },
 * });
 * ```
 */
export function createComponent(params: {
  messageId: string;
  responseId?: string;
  componentName: string;
  props?: Record<string, unknown>;
  streaming?: ComponentStreaming;
  fallbackText?: string;
  fallbackMarkdown?: string;
  hidden?: boolean;
  channel?: string;
  voiceDelivery?: AgentContentBase['voiceDelivery'];
  progress?: UserFacingProgress;
}): ComponentContent {
  return {
    type: ContentType.Component,
    messageId: params.messageId,
    responseId: params.responseId,
    componentName: params.componentName,
    props: params.props ?? {},
    streaming: params.streaming,
    fallbackText: params.fallbackText,
    fallbackMarkdown: params.fallbackMarkdown,
    hidden: params.hidden,
    channel: params.channel,
    voiceDelivery: params.voiceDelivery,
    progress: params.progress,
  };
}

/**
 * Create a streaming tool component in input-streaming state.
 */
export function createStreamingComponent(params: {
  messageId: string;
  responseId?: string;
  componentName: string;
  toolName: string;
  toolCallId: string;
  inputDelta?: string;
  props?: Record<string, unknown>;
}): ComponentContent {
  return createComponent({
    messageId: params.messageId,
    responseId: params.responseId,
    componentName: params.componentName,
    props: params.props,
    streaming: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      state: 'input-streaming',
      inputDelta: params.inputDelta ?? '',
    },
  });
}

/**
 * Create a streaming tool component in output-available state.
 *
 * Note: `output` is no longer sent to UI to avoid large payloads.
 * Use `props` for UI-specific data instead.
 */
export function createComponentResult(params: {
  messageId: string;
  responseId?: string;
  componentName: string;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  props?: Record<string, unknown>;
  fallbackText?: string;
  fallbackMarkdown?: string;
}): ComponentContent {
  return createComponent({
    messageId: params.messageId,
    responseId: params.responseId,
    componentName: params.componentName,
    props: params.props,
    fallbackText: params.fallbackText,
    fallbackMarkdown: params.fallbackMarkdown,
    streaming: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      state: 'output-available',
      input: params.input,
    },
  });
}

/**
 * Create a streaming tool component in output-error state.
 */
export function createComponentError(params: {
  messageId: string;
  responseId?: string;
  componentName: string;
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  error: string;
  props?: Record<string, unknown>;
}): ComponentContent {
  return createComponent({
    messageId: params.messageId,
    responseId: params.responseId,
    componentName: params.componentName,
    props: params.props,
    streaming: {
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      state: 'output-error',
      input: params.input,
      error: params.error,
    },
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a shallow copy of content (for immutable updates).
 */
export function copyContent<T extends AgentContent>(content: T): T {
  if (content.type === ContentType.Text) {
    return { ...content } as T;
  }
  if (content.type === ContentType.Audio) {
    return { ...content, content: { ...content.content } } as T;
  }
  if (content.type === ContentType.Tool) {
    return {
      ...content,
      tool: { ...content.tool },
      streaming: content.streaming ? { ...content.streaming } : undefined,
    } as T;
  }
  if (content.type === ContentType.Component) {
    const comp = content as ComponentContent;
    return {
      ...comp,
      props: { ...comp.props },
      streaming: comp.streaming
        ? {
            ...comp.streaming,
            input: comp.streaming.input ? { ...comp.streaming.input } : undefined,
          }
        : undefined,
    } as T;
  }
  return { ...content } as T;
}

/**
 * Type guard for ComponentContent.
 */
export function isComponentContent(content: AgentContent): content is ComponentContent {
  return content.type === ContentType.Component;
}

/**
 * Type guard for streaming ComponentContent.
 */
export function isStreamingComponent(
  content: AgentContent,
): content is ComponentContent & { streaming: ComponentStreaming } {
  return content.type === ContentType.Component && !!(content as ComponentContent).streaming;
}

/**
 * Identifies component content in a transient streaming state that has not yet settled.
 *
 * Intermediate states (`input-streaming`, `input-available`, `output-pending`) are
 * architectural ephemera — they exist only during live stream delivery and must never
 * be treated as durable. Only the final states (`output-available`, `output-error`)
 * are written to persistent storage or replay buffers.
 *
 * Use this to:
 * - Filter what gets written to a replay buffer or DynamoDB (skip non-final states)
 * - Clear in-progress messages before replaying history on reconnect
 * - Decide which states to emit to downstream channels (Discord, email, etc.)
 */
export function isStreamingDelta(content: AgentContent): boolean {
  if (content.type !== ContentType.Component) {
    return false;
  }
  const streaming = (content as ComponentContent).streaming;
  if (!streaming) {
    return false;
  }
  return (
    streaming.state === 'input-streaming' ||
    streaming.state === 'input-available' ||
    streaming.state === 'output-pending'
  );
}

/**
 * Type guard for user messages.
 */
export function isUserContent(content: AgentContent): boolean {
  return content.role === 'user';
}
