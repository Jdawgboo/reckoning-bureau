/**
 * Agent Library Re-exports
 *
 * Barrel file that re-exports types and utilities from the local vendor agent-library.
 * The browser vendor contains only browser-safe files (UI, types, utilities).
 */

// Re-export everything from the UI module (browser-safe)
export {
  // Content Types
  ContentType,
  type AgentContent,
  type AgentMessagePayload,
  type TextContent,
  type ToolContent,
  type ComponentContent,
  type ComponentStreaming,
  type ComponentProps,
  type ToolPartState,
  // Content Utilities
  createTextContent,
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
  // UI Types
  AgentConversation,
  type ConversationState,
  type ConversationStatus,
  type MessageGroup,
  // Message Grouping
  computeMessageGroups,
  getLastGroup,
  getLastResponses,
  // Content Reducer
  contentReducer,
  createInitialContentState,
  selectContentList,
  selectTextContent,
  selectStreamingComponents,
  selectHasActiveTools,
  defaultUiMergeStrategy,
  type ContentState,
  type ContentAction,
  // Component View Helpers
  type ComponentView,
  getComponentView,
  // Streaming JSON Parser
  createStreamingJsonParser,
  type StreamingJsonParser,
  // Component Props Resolver
  ComponentPropsResolver,
  createComponentPropsResolver,
  type ResolvedComponentProps,
  // Generic guards
  isPlainObject,
} from '../../vendor/agent-library/ui/index.ts';

// AG-UI event contract + projector (browser-safe; same code the server emits with)
export {
  aguiEvent,
  isAguiEvent,
  AGUI_CUSTOM_EVENT_NAMES,
  type AguiEvent,
} from '../../vendor/agent-library/agui/events.ts';
export { AguiContentProjector } from '../../vendor/agent-library/agui/content-projector.ts';

// Streaming utilities (browser-safe)
export {
  RetryLoop,
  type RetryLoopDeps,
  type RetryLoopOptions,
} from '../../vendor/agent-library/streaming/retry-loop.ts';

// Streaming lifecycle (vendor copies created in Task 2/13 via npm run copy:agent)
export {
  AgentStreamSession,
  type AgentStreamSessionOptions,
  type StreamState,
} from '../../vendor/agent-library/ui/agent-stream-session.ts';
export type { IStreamingStore } from '../../vendor/agent-library/ui/streaming-store.ts';
