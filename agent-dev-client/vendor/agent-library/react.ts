/**
 * @agentplace/agent/react - Browser-safe React utilities
 *
 * This entry point is designed for browser/React applications.
 * It exports only browser-compatible code with no Node.js dependencies.
 *
 * @example
 * ```tsx
 * import {
 *   // High-level conversation manager
 *   AgentConversation,
 *
 *   // React hooks
 *   useAgentStream,
 *   useComponent,
 *   contentReducer,
 *
 *   // Content types
 *   ContentType,
 *   textExtensions,
 * } from '@agentplace/agent/react';
 * ```
 */

// Re-export everything from /ui (which contains conversation management, hooks, etc.)
export {
  // Content State Management
  contentReducer,
  createInitialContentState,
  selectContentList,
  selectTextContent,
  selectStreamingComponents,
  selectHasActiveTools,
  defaultUiMergeStrategy,
  type ContentState,
  type ContentAction,
  // React Hooks
  useAgentStream,
  useHasActiveTools,
  type UseAgentStreamOptions,
  type UseAgentStreamResult,
  // Conversation Management (High-level)
  AgentConversation,
  // Conversation Management (Mid-level)
  processAgentEvent,
  extractStateUpdate,
  isHiddenSystemTool,
  type ProcessEventResult,
  // Conversation Management (Low-level)
  computeGroups,
  computeMessageGroups,
  getLastGroup,
  getLastResponses,
  // Conversation Types
  type ConversationState,
  type ConversationStatus,
  type ConversationConfig,
  type ConversationHeaders,
  type ConversationMessage,
  type ConversationSnapshot,
  type RunTerminalStatus,
  type MessageGroup,
  type StateListener,
  type SystemToolHandler,
  type SendParams,
  type Attachment,
  type AgentMessagePayload,
  // Content Types
  ContentType,
  type AgentContent,
  type TextContent,
  type ComponentContent,
  type ComponentStreaming,
  type ComponentProps,
  type ToolPartState,
  // Component functions
  createComponent,
  createStreamingComponent,
  createComponentResult,
  createComponentError,
  toComponentProps,
  isComponentContent,
  isStreamingComponent,
  isComponentLoading,
  isComponentStreaming,
  isComponentDone,
  // Component view helpers
  getComponentView,
  type ComponentView,
  // Component hooks
  useComponent,
  type UseComponentOptions,
  type UseComponentResult,
  // Streaming JSON
  useStreamingJson,
  type UseStreamingJsonOptions,
  type UseStreamingJsonResult,
  // Streaming JSON Parser
  createStreamingJsonParser,
  type StreamingJsonParser,
  type StreamingJsonState,
  // Stream Utilities
  type UiSink,
  mergeContentDeltas,
  type MergeStrategy,
  StreamThrottler,
  // Streaming Lifecycle
  ResumeController,
  AgentStreamSession,
  type AgentStreamSessionOptions,
  type StreamState,
  // Messaging Store Contract
  type IStreamingStore,
} from './ui/index.ts';

// Additional content types not in /ui
export {
  type AgentContentBase,
  type AudioContent,
  type ToolContent,
  createTextContent,
  createAudioContent,
  createToolContent,
  copyContent,
  isUserContent,
  isStreamingDelta,
} from './types/content.ts';

// User-message identity (shared client/server id derivation)
export { userMessageIdFor } from './sessions/user-message-id.ts';

// File utilities
export { textExtensions } from './util/extensions.ts';

// Stream types
export type { CancelableStream } from './types/cancelable-stream.ts';
