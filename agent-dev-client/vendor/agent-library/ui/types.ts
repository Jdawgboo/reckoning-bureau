/**
 * Conversation Types
 *
 * Core types for the AgentConversation class.
 * These are framework-agnostic and work with any state management.
 */

import type { AgentContent, ComponentContent } from '../types/content.ts';
import type { LlmErrorCode } from '../types/errors.ts';

/**
 * Conversation status states
 */
export type ConversationStatus = 'idle' | 'streaming' | 'error';

/**
 * Terminal outcome of a run whose output never finalized.
 */
export type RunTerminalStatus = 'aborted' | 'error';

/**
 * A message held by the conversation: canonical content plus conversation-layer
 * delivery annotations.
 *
 * `runTerminal` marks a retained overlay item (delta-delivered, never promoted
 * to durable by a committed snapshot) whose run ended in `aborted`/`error` —
 * the durable record may not include this never-finalized output, so the mark
 * keeps the rendered state truthful. The annotation lives at the UI layer only:
 * it is never written to persisted content types, and a later snapshot
 * promotion of the same id replaces the message, clearing the mark.
 */
export type ConversationMessage = AgentContent & { runTerminal?: RunTerminalStatus };

/**
 * Message group - one turn (run), keyed on the run's `responseId`.
 * Similar to AI SDK's message grouping pattern.
 *
 * A turn opens on a user message or on a new (not-yet-owned) `responseId` —
 * see `computeMessageGroups` for the full boundary rule. `kind` labels how the
 * turn was opened, derived rather than stored:
 * - `'user'` — opened by a visible (non-hidden) user message.
 * - `'home'` — opened by a hidden user message, or the first turn of the
 *   session when it has no user request (welcome/greeting content).
 * - `'agent'` — no user request, and not the first turn: an agent-initiated
 *   run (trigger, schedule, notification, proactive delivery).
 */
export interface Group<T> {
  /** Unique ID for this group */
  id: string;
  /** User message that started this exchange (null for initial agent messages) */
  request: T | null;
  /** All agent responses in this exchange */
  responses: T[];
  /**
   * The run id this turn is keyed on, adopted from the first item (user echo
   * or assistant content) that carries a non-empty `responseId`. Undefined
   * when no item in the turn has carried one yet (e.g. a live optimistic user
   * message with no run assigned yet, or legacy content with no `responseId`
   * at all).
   */
  responseId?: string;
  /** How this turn was opened — see interface doc for the derivation rule. */
  kind: 'user' | 'home' | 'agent';
}

/**
 * The three facts the turn-boundary rule needs from an item, so the rule can be
 * shared by callers holding different item types (agent-library's
 * `AgentContent`, admin-client's MobX `MessageModel`).
 */
export interface GroupableItem {
  isUserMessage: boolean;
  responseId?: string;
  hidden?: boolean;
}

/** A turn over `AgentContent` — the agent-library specialisation of {@link Group}. */
export type MessageGroup = Group<AgentContent>;

/**
 * Main conversation state exposed to UI/state handlers.
 * This is what UI frameworks observe for reactivity.
 */
export interface ConversationState {
  /** All messages in order */
  messages: ConversationMessage[];
  /** Messages grouped by user request */
  groupedMessages: MessageGroup[];
  /** Current conversation status */
  status: ConversationStatus;
  /** Error if status is 'error' */
  error: Error | null;
}

/**
 * Headers type compatible with both Node.js and browser environments.
 */
export type ConversationHeaders = Record<string, string> | [string, string][];

/**
 * Configuration for AgentConversation.
 */
export interface ConversationConfig {
  /**
   * System tools that should not create visible messages.
   * StateUpdate is always included automatically.
   * @default ['UpdateChecklist']
   */
  hiddenSystemTools?: string[];

  /**
   * Convenience: attach a state listener at construction time.
   * This covers the common "one store owns the conversation" case and avoids
   * forgetting to unsubscribe.
   */
  onStateChange?: StateListener | StateListener[];

  /**
   * Convenience: attach a system tool handler at construction time.
   */
  onSystemTool?: SystemToolHandler | SystemToolHandler[];

  /**
   * Convenience: attach a message upsert handler at construction time.
   * Called with the specific message that was added or updated.
   * Enables efficient O(1) cache updates in state management.
   */
  onMessageUpsert?: MessageUpsertHandler | MessageUpsertHandler[];

  /**
   * Called after any state mutation with full snapshot.
   * Use for persistence - fires after every change, consumer can debounce.
   */
  onSnapshot?: SnapshotHandler | SnapshotHandler[];
}

/**
 * Parameters for sending a message.
 */
export interface SendParams {
  /** Message text content */
  content: string;
  /** File attachments */
  files?: Attachment[];
  /** Additional metadata to include in request */
  metadata?: Record<string, unknown>;
}

/**
 * Attachment type (simplified for library - apps can extend)
 */
export interface Attachment {
  name: string;
  type: string;
  data: string;
  [key: string]: unknown;
}

/**
 * Snapshot for persistence.
 * Contains everything needed to restore conversation state.
 *
 * Format versioning via `durableIds`:
 * - Snapshots produced by `AgentConversation.snapshot()` contain only durable
 *   (committed-snapshot-delivered) messages and list their ids in `durableIds`;
 *   `restore()` re-marks those ids durable, so replayed deltas for them are
 *   dropped after rehydration.
 * - Legacy snapshots (and ad-hoc `restore({ messages })` calls) have no
 *   `durableIds` field and load exactly as before: messages are rendered but
 *   nothing is marked durable, so delta accumulation is unaffected.
 */
export interface ConversationSnapshot {
  /** All messages */
  messages: AgentContent[];
  /** Ids of messages that were delivered as committed snapshots (durable). */
  durableIds?: string[];
}

/**
 * State listener callback type.
 * Receives both current and previous state for comparison.
 */
export type StateListener = (state: ConversationState, prevState: ConversationState) => void;

/**
 * System tool handler callback type.
 * Called for all Tool messages except StateUpdate.
 */
export type SystemToolHandler = (toolName: string, data: unknown) => void;

/**
 * Message upsert handler callback type.
 * Called when a message is added or updated, with the final merged message.
 * Enables O(1) cache updates instead of scanning all messages.
 *
 * @param message - The upserted message (after any merging)
 * @param isNew - true if this is a new message, false if updating existing
 */
export type MessageUpsertHandler = (message: AgentContent, isNew: boolean) => void;

/**
 * Snapshot handler callback type.
 * Called after any state mutation with full snapshot.
 * Use for persistence - fires after every change, consumer can debounce.
 */
export type SnapshotHandler = (snapshot: ConversationSnapshot) => void;

/**
 * Agent message payload (what comes from SSE stream).
 *
 * This is a discriminated union on `type`:
 * - Text: has `content: string`
 * - Tool: has `tool` and `content`
 * - Component: unified type for simple UI and streaming tools
 */
export type AgentMessagePayload =
  | AgentMessagePayloadText
  | AgentMessagePayloadTool
  | ComponentContent; // Unified component (simple UI or streaming tool)

interface AgentMessagePayloadBase {
  messageId: string;
  responseId?: string;
}

interface AgentMessagePayloadText extends AgentMessagePayloadBase {
  type: 'TXT';
  content: string;
  isReasoning?: boolean;
  role?: 'user';
  hidden?: boolean;
  /** Machine-readable LLM error category when this text is a terminal error message. */
  errorCode?: LlmErrorCode;
  /**
   * Present on snapshot deliveries of output that was cut off mid-stream —
   * the run ended (abort/error) before this message finalized.
   */
  partial?: true;
}

interface AgentMessagePayloadTool extends AgentMessagePayloadBase {
  type: 'Tool';
  tool: { name: string };
  content: unknown;
}
