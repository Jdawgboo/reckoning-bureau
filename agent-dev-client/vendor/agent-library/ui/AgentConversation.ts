/**
 * AgentConversation
 *
 * Framework-agnostic conversation manager that handles protocol-specific logic
 * automatically (StateUpdate, tool streaming, lastStateUpdate).
 *
 * Similar to AI SDK's useChat but designed for subscribe pattern.
 *
 * @example
 * ```typescript
 * // Simplest: With MobX
 * const conversation = new AgentConversation({
 *   onStateChange: action((state) => {
 *     this.messages = state.messages;
 *     this.status = state.status;
 *   }),
 *   onSystemTool: action((tool, data) => {
 *     if (tool === 'UpdateChecklist') {
 *       this.checklist = data.items;
 *     }
 *   }),
 * });
 *
 * // Process SSE events
 * handleSSE(event) {
 *   conversation.process(event);
 * }
 *
 * // API request
 * await api.post('/chat', { message });
 * ```
 */

import {
  ContentType,
  type AgentContent,
  type TextContent,
  type ComponentContent,
  createTextContent,
  createAudioContent,
  isStreamingDelta,
} from '../types/content.ts';

import { computeMessageGroups } from './message-grouper.ts';

import type {
  ConversationState,
  ConversationConfig,
  ConversationMessage,
  ConversationSnapshot,
  RunTerminalStatus,
  StateListener,
  SystemToolHandler,
  MessageUpsertHandler,
  SnapshotHandler,
  AgentMessagePayload,
} from './types.ts';

/**
 * AgentConversation - Conversation lifecycle manager
 *
 * Handles:
 * - Message state management
 * - StateUpdate tool (protocol) - stored automatically
 * - Message grouping (user request + agent responses)
 * - Persistence (snapshot/restore)
 */
export class AgentConversation {
  // === Internal State ===

  private state: ConversationState = {
    messages: [],
    groupedMessages: [],
    status: 'idle',
    error: null,
  };

  private prevState: ConversationState = { ...this.state };

  /**
   * Messages whose content was set by a committed snapshot delivery (durable).
   * Replayed deltas for them are stale and dropped; only durable items are
   * persisted by {@link snapshot}.
   */
  #durableIds = new Set<string>();

  /** State change handlers (constructor callbacks only) */
  private stateListeners: StateListener[] = [];

  /** System tool handlers (constructor callbacks only) */
  private systemToolHandlers: SystemToolHandler[] = [];

  /** Message upsert handlers (constructor callbacks only) */
  private messageUpsertHandlers: MessageUpsertHandler[] = [];

  /** Snapshot handlers (constructor callbacks only) */
  private snapshotHandlers: SnapshotHandler[] = [];

  /** Configuration */
  private config: ConversationConfig;

  constructor(config: ConversationConfig = {}) {
    this.config = {
      hiddenSystemTools: ['UpdateChecklist'],
      ...config,
    };

    const stateListeners = this.config.onStateChange;
    this.stateListeners = stateListeners
      ? Array.isArray(stateListeners)
        ? stateListeners
        : [stateListeners]
      : [];

    const systemToolHandlers = this.config.onSystemTool;
    this.systemToolHandlers = systemToolHandlers
      ? Array.isArray(systemToolHandlers)
        ? systemToolHandlers
        : [systemToolHandlers]
      : [];

    const messageUpsertHandlers = this.config.onMessageUpsert;
    this.messageUpsertHandlers = messageUpsertHandlers
      ? Array.isArray(messageUpsertHandlers)
        ? messageUpsertHandlers
        : [messageUpsertHandlers]
      : [];

    const snapshotHandlers = this.config.onSnapshot;
    this.snapshotHandlers = snapshotHandlers
      ? Array.isArray(snapshotHandlers)
        ? snapshotHandlers
        : [snapshotHandlers]
      : [];

    // Keep backwards behavior: call state listeners immediately with current state.
    this.stateListeners.forEach((listener) => {
      listener(this.state, this.prevState);
    });
  }

  // === Actions ===

  /**
   * Clear all messages and state.
   */
  clear(): void {
    this.setState({
      messages: [],
      groupedMessages: [],
      status: 'idle',
      error: null,
    });
  }

  /**
   * Remove in-progress streaming messages, keeping only settled ones.
   * Streaming messages are Component items whose streaming state is
   * input-streaming, input-available, or output-pending.
   * Call before replaying committed content from the server to avoid duplicates.
   */
  clearStreamingMessages(): void {
    const filtered = this.state.messages.filter((msg) => !isStreamingDelta(msg));
    if (filtered.length !== this.state.messages.length) {
      this.setState({ messages: filtered, groupedMessages: computeMessageGroups(filtered) });
    }
  }

  /**
   * Remove a single message by id. Use this to retract an optimistic message —
   * e.g. a user message whose send turned out to be queued, so it should live
   * only in the queue strip and not in the thread. No-op if the id is absent. A
   * later committed record with the same id re-enters as a new message.
   */
  removeMessage(messageId: string): void {
    const filtered = this.state.messages.filter((msg) => msg.messageId !== messageId);
    if (filtered.length !== this.state.messages.length) {
      this.setState({ messages: filtered, groupedMessages: computeMessageGroups(filtered) });
    }
  }

  /**
   * Add a user message to the conversation.
   * Use this when handling transport yourself.
   *
   * @param params.content - Text string or audio data object
   * @param params.extra - Optional app-specific fields (e.g., files, uiText)
   * @returns The generated message ID
   *
   * @example
   * ```typescript
   * // Simple text message
   * const messageId = conversation.addUserMessage({ content: 'Hello!' });
   *
   * // With app-specific extensions
   * const messageId = conversation.addUserMessage({
   *   content: 'Check this file',
   *   extra: { files: [...], uiText: 'display text' },
   * });
   * ```
   */
  addUserMessage(params: {
    content: string | { data: string; text?: string };
    extra?: Record<string, unknown>;
    /**
     * Stable id minted by the caller (e.g. `userMessageIdFor(requestId)`) so
     * the optimistic message reconciles by id with its committed record when
     * history or a tail sweep later delivers it. Defaults to a random UUID.
     */
    messageId?: string;
  }): string {
    const messageId = params.messageId ?? crypto.randomUUID();

    let message: AgentContent;
    if (typeof params.content === 'string') {
      message = {
        ...createTextContent({
          messageId,
          content: params.content,
          role: 'user',
        }),
        ...params.extra,
      };
    } else {
      message = {
        ...createAudioContent({
          messageId,
          content: params.content,
          role: 'user',
        }),
        ...params.extra,
      };
    }

    const messages = [...this.state.messages, message];
    this.messageUpsertHandlers.forEach((handler) => {
      void handler(message, true);
    });
    this.setState({ messages });

    return messageId;
  }

  // === Manual Transport Mode ===

  /**
   * Process an incoming SSE event.
   * Use this when handling transport yourself.
   *
   * Handles automatically:
   * - StateUpdate tool (stored for next request)
   * - Text/Component messages
   *
   * @example
   * ```typescript
   * eventSource.onmessage = (event) => {
   *   const payload = JSON.parse(event.data);
   *   conversation.process(payload);
   * };
   * ```
   */
  process(payload: AgentMessagePayload, options?: { snapshot?: boolean }): void {
    // 1. Handle app-specific system tools (no visible message for tools)
    if (payload.type === ContentType.Tool) {
      const toolPayload = payload as AgentMessagePayload & {
        tool: { name: string };
        content: unknown;
      };
      this.systemToolHandlers.forEach((handler) => {
        handler(toolPayload.tool.name, toolPayload.content);
      });
      return; // Don't create visible message for tools
    }

    // 3. Handle text
    if (payload.type === ContentType.Text) {
      const content = createTextContent({
        messageId: payload.messageId,
        responseId: payload.responseId,
        content: payload.content as string,
        isReasoning: payload.isReasoning,
        role: payload.role,
        hidden: payload.hidden,
        errorCode: payload.errorCode,
      });
      this.upsertMessage(content, options?.snapshot === true);
      return;
    }

    // 4. Handle Component (unified type - simple UI or streaming tool)
    if (payload.type === ContentType.Component) {
      this.upsertMessage(payload as AgentContent, options?.snapshot === true);
      return;
    }
  }

  /**
   * Answer a blocking tool by naming the rendered component the user acted on.
   * The SDK derives the correlation id from the component's `messageId` and
   * builds the wire payload — the consumer never handles a tool-call id.
   */
  respondToComponent(
    component: { messageId: string },
    output: string,
  ): { resumeToolResults: Array<{ toolCallId: string; output: string }> } {
    return { resumeToolResults: [{ toolCallId: component.messageId, output }] };
  }

  /**
   * Mark the retained overlay output of a terminated run.
   *
   * When a run ends in `aborted`/`error`, its durable record may not include
   * output that never finalized. Delta-delivered (non-durable) messages of that
   * run stay in the conversation as an overlay; this stamps them with the
   * terminal status so the rendered state is truthful. Durable messages are
   * untouched, and a later snapshot promotion of a marked id replaces the
   * message — the mark does not survive promotion.
   */
  markRunTerminal(responseId: string, status: RunTerminalStatus): void {
    const marked: ConversationMessage[] = [];
    const messages = this.state.messages.map((message) => {
      const isOverlayOfRun =
        message.responseId === responseId && !this.#durableIds.has(message.messageId);
      if (!isOverlayOfRun || message.runTerminal === status) {
        return message;
      }
      const updated: ConversationMessage = { ...message, runTerminal: status };
      marked.push(updated);
      return updated;
    });

    if (marked.length === 0) {
      return;
    }

    marked.forEach((message) => {
      this.messageUpsertHandlers.forEach((handler) => {
        void handler(message, false);
      });
    });
    this.setState({ messages });
  }

  /**
   * Set streaming status.
   * Call when starting a request (if using manual transport).
   */
  setStreaming(): void {
    this.setStatus('streaming');
  }

  /**
   * Set idle status.
   * Call when request completes (if using manual transport).
   */
  setIdle(): void {
    this.setStatus('idle');
  }

  // === Persistence ===

  /**
   * Get snapshot for saving to storage.
   *
   * Only durable messages (delivered as committed snapshots) are persisted —
   * in-flight delta-only output is ephemeral and excluded. Their ids are
   * listed in `durableIds` so {@link restore} can re-mark them.
   *
   * @example
   * ```typescript
   * localStorage.setItem('chat', JSON.stringify(conversation.snapshot()));
   * ```
   */
  snapshot(): ConversationSnapshot {
    const messages = this.state.messages.filter((message) =>
      this.#durableIds.has(message.messageId),
    );
    return {
      messages,
      durableIds: messages.map((message) => message.messageId),
    };
  }

  /**
   * Restore from snapshot.
   *
   * Snapshots carrying `durableIds` re-mark those messages durable, so replayed
   * deltas for them are dropped after rehydration. Legacy snapshots (no
   * `durableIds`) load exactly as before: nothing is marked durable.
   *
   * @example
   * ```typescript
   * const saved = JSON.parse(localStorage.getItem('chat'));
   * if (saved) conversation.restore(saved);
   * ```
   */
  restore(snapshot: ConversationSnapshot): void {
    this.clearStreamingMessages();
    if (snapshot.durableIds) {
      this.#durableIds = new Set(snapshot.durableIds);
    }
    const messages = snapshot.messages || [];

    messages.forEach((message) => {
      this.messageUpsertHandlers.forEach((handler) => {
        void handler(message, true);
      });
    });

    this.setState({
      messages,
      groupedMessages: computeMessageGroups(messages),
      status: 'idle',
      error: null,
    });
  }

  // === Getters ===

  /**
   * Get current state (read-only).
   * Prefer using `onStateChange` constructor callback for reactive updates.
   */
  getState(): Readonly<ConversationState> {
    return this.state;
  }

  // === Internal Methods ===

  private setState(partial: Partial<ConversationState>): void {
    this.prevState = { ...this.state };
    this.state = { ...this.state, ...partial };

    this.stateListeners.forEach((listener) => {
      listener(this.state, this.prevState);
    });

    this.notifySnapshot();
  }

  private setStatus(status: ConversationState['status']): void {
    this.setState({ status, error: status === 'idle' ? null : this.state.error });
  }

  /**
   * Notify snapshot handlers with current snapshot.
   * Called after any state mutation.
   */
  private notifySnapshot(): void {
    if (this.snapshotHandlers.length === 0) {
      return;
    }
    const snapshot = this.snapshot();
    this.snapshotHandlers.forEach((handler) => {
      void handler(snapshot);
    });
  }

  /**
   * Upsert message - update existing or add new.
   *
   * Delivery kind decides durability for every content type: a **snapshot**
   * delivery (committed record re-delivered by history pages or tail sweeps)
   * marks the message durable, and any later non-snapshot delivery for a
   * durable id is a stale replay and is dropped.
   *
   * Text merge strategy depends on delivery and role:
   * - **Snapshots** carry the message's full text: replace idempotently.
   * - **User messages** are sent as a single payload (never streamed in chunks),
   *   so a duplicate `messageId` means a replay (reconnect / resume).
   *   We replace the content idempotently instead of concatenating.
   * - **Assistant messages** arrive as streaming chunks sharing a `messageId`,
   *   so we append (accumulate) content.
   *
   * Component snapshots replace the message wholesale — committed records are
   * complete, so props are not re-merged and inputDelta is not re-accumulated.
   *
   * Flags (`hidden`, `role`) are preserved with "sticky" semantics:
   * once set to a truthy value they are never downgraded by a later update.
   */
  private upsertMessage(content: AgentContent, snapshot = false): void {
    if (snapshot) {
      this.#durableIds.add(content.messageId);
    } else if (this.#durableIds.has(content.messageId)) {
      return;
    }
    const messages = [...this.state.messages];
    const existingIndex = messages.findIndex((m) => m.messageId === content.messageId);
    const isNew = existingIndex < 0;

    if (!isNew) {
      const existing = messages[existingIndex];

      if (existing.type === ContentType.Text && content.type === ContentType.Text) {
        const prev = existing as TextContent;
        const next = content as TextContent;

        const mergedRole = prev.role ?? next.role;
        const mergedHidden = prev.hidden || next.hidden || undefined;

        // User messages: idempotent replace (sent once, never streamed).
        // Keep previous content when the incoming payload is empty (e.g. replay of hidden welcome message).
        const isUserMessage = mergedRole === 'user';
        const mergedContent =
          snapshot || isUserMessage ? next.content || prev.content : prev.content + next.content;

        const merged: ConversationMessage = {
          ...prev,
          content: mergedContent,
          isReasoning: next.isReasoning,
          role: mergedRole,
          hidden: mergedHidden,
        };
        if (snapshot) {
          delete merged.runTerminal;
        }
        messages[existingIndex] = merged;
      }
      // Component snapshot: the committed record is complete — replace wholesale.
      else if (
        snapshot &&
        existing.type === ContentType.Component &&
        content.type === ContentType.Component
      ) {
        messages[existingIndex] = content;
      }
      // Component delta: merge props and streaming state
      else if (existing.type === ContentType.Component && content.type === ContentType.Component) {
        const existingComp = existing as ComponentContent;
        const newComp = content as ComponentContent;

        // Merge streaming state if both have it
        let mergedStreaming = newComp.streaming;
        if (existingComp.streaming && newComp.streaming) {
          mergedStreaming = {
            ...existingComp.streaming,
            ...newComp.streaming,
            // Accumulate inputDelta
            inputDelta:
              (existingComp.streaming.inputDelta || '') + (newComp.streaming.inputDelta || ''),
            // Prefer new values, fallback to existing
            input: newComp.streaming.input ?? existingComp.streaming.input,
            error: newComp.streaming.error ?? existingComp.streaming.error,
          };
        }

        messages[existingIndex] = {
          ...existingComp,
          ...newComp,
          // Merge props
          props: { ...existingComp.props, ...newComp.props },
          streaming: mergedStreaming,
        };
      }
      // Otherwise replace
      else {
        messages[existingIndex] = content;
      }
    } else {
      messages.push(content);
    }

    const finalMessage = isNew ? content : messages[existingIndex];
    this.messageUpsertHandlers.forEach((handler) => {
      void handler(finalMessage, isNew);
    });

    this.setState({ messages });
  }
}
