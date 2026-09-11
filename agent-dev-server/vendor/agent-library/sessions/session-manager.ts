import type { StateTree } from '../state/state-tree.ts';
import type { RunStatusSink } from './run-status-sink.ts';
import { generateShortId } from '../types/id.ts';
import type { AgentContent } from '../types/content.ts';
import { createTextContent, createAudioContent, createComponent } from '../types/content.ts';
import { ContentType } from '../types/content.ts';
import { isCheckpointMessage, readCheckpointData } from './checkpoint.ts';
import { stripModelOnlyContext } from './content-builder.ts';
import { SerialQueue } from '../core/serial-queue.ts';
import type { ResolvedToolResults } from '../core/blocking.ts';
import { toPersistableMessages } from './serialize.ts';
import type { AgentMessages } from './produced-messages.ts';
import type { AgentContentEvent } from './produced-content.ts';
import { getAgentLogger } from '../types/logger.ts';
import type { CurrentRun } from './resolve-run-status.ts';
import type {
  SessionSummary,
  SessionType,
  SessionStatus,
  ConversationMessage,
  ActivityEntry,
  PersistedContentItem,
  SessionInboxEvent,
} from './types.ts';
import {
  type SessionTypeHandler,
  createDefaultHandlers,
  truncateSessionName,
} from './session-type-handler.ts';

/** Convert a persisted content item to an AgentContent object for consumers. */
export function toAgentContent(item: PersistedContentItem): AgentContent | null {
  if (item.type === 'text' && item.text) {
    if (item.audioData) {
      return createAudioContent({
        messageId: item.messageId,
        responseId: item.responseId,
        content: { data: item.audioData, text: item.text },
        role: item.role === 'user' ? 'user' : undefined,
      });
    }
    // Strip model-only context blocks (e.g. <internal_request_metadata>) that
    // may be embedded in user text — guards against records stored before
    // content-builder.ts applied the strip at write time.
    const text = item.role === 'user' ? stripModelOnlyContext(item.text) : item.text;
    if (!text) {
      return null;
    }
    return createTextContent({
      messageId: item.messageId,
      responseId: item.responseId,
      content: text,
      isReasoning: item.isReasoning,
      role: item.role === 'user' ? 'user' : undefined,
      hidden: item.hidden,
      channel: item.channel,
      voiceDelivery: item.voiceDelivery,
    });
  }
  if (item.type === 'component' && item.componentName) {
    return createComponent({
      messageId: item.messageId,
      responseId: item.responseId,
      componentName: item.componentName,
      props: item.props ?? {},
      fallbackText: item.fallbackText,
      fallbackMarkdown: item.fallbackMarkdown,
      hidden: item.hidden,
      channel: item.channel,
      voiceDelivery: item.voiceDelivery,
      streaming: item.toolCallId
        ? {
            toolName: item.toolName ?? '',
            toolCallId: item.toolCallId,
            state: 'output-available' as const,
            input: {},
          }
        : undefined,
    });
  }
  return null;
}

/**
 * Convert a live AgentContent item to a persisted CONTENT# record.
 *
 * Inverse of `toAgentContent`, preserving the stream's `messageId`. Returns
 * null for content kinds CONTENT# does not represent (e.g. Tool lifecycle
 * items, which are observer-only) — matching what `toAgentContent` can load.
 */
export function toPersistedContentItem(content: AgentContent): PersistedContentItem | null {
  if (content.type === ContentType.Text) {
    return {
      messageId: content.messageId,
      responseId: content.responseId,
      role: content.role === 'user' ? 'user' : 'assistant',
      type: 'text',
      text: content.content,
      isReasoning: content.isReasoning,
      hidden: content.hidden,
      channel: content.channel,
      voiceDelivery: content.voiceDelivery,
    };
  }
  if (content.type === ContentType.Audio) {
    return {
      messageId: content.messageId,
      responseId: content.responseId,
      role: content.role === 'user' ? 'user' : 'assistant',
      type: 'text',
      text: content.content.text,
      audioData: content.content.data,
    };
  }
  if (content.type === ContentType.Component) {
    return {
      messageId: content.messageId,
      responseId: content.responseId,
      role: 'assistant',
      type: 'component',
      componentName: content.componentName,
      props: content.props ?? {},
      fallbackText: content.fallbackText,
      fallbackMarkdown: content.fallbackMarkdown,
      toolCallId: content.streaming?.toolCallId,
      toolName: content.streaming?.toolName,
      hidden: content.hidden,
      channel: content.channel,
      voiceDelivery: content.voiceDelivery,
    };
  }
  return null;
}

/**
 * SessionManager — unified session management using the state tree.
 *
 * Thin wrapper over state.sessions accessor and tree operations.
 * No manual caching, subscription management, or reconnect handling —
 * the state tree owns all of that.
 */
const recordLogger = getAgentLogger();

/** Construction options for `SessionManager`. */
export interface SessionManagerOptions {
  /**
   * Identity of the agent whose state this manager operates on (the backend it
   * wraps is already agent-scoped). Required when `runStatusSink` is set:
   * every sink event carries it, so hosts receive fully-scoped run-lifecycle
   * events and never reverse-map sessionId → agentId.
   */
  agentId?: string;
  runStatusSink?: RunStatusSink;
}

export class SessionManager {
  #state: StateTree;
  #handlers: Map<SessionType, SessionTypeHandler>;
  /**
   * Present iff a RunStatusSink was injected. Bundles the sink with the
   * manager's agent scope so every emission is fully scoped by construction —
   * a sink without an agentId is rejected in the constructor.
   */
  readonly #runStatusScope?: { sink: RunStatusSink; agentId: string };
  #lastSeqBySession = new Map<string, number>();
  #lastContentSeqBySession = new Map<string, number>();
  #recordQueue = new SerialQueue((err) =>
    recordLogger.warn('[SessionManager] record task failed', { error: err }),
  );
  #contentRecordQueue = new SerialQueue((err) =>
    recordLogger.warn('[SessionManager] content record task failed', { error: err }),
  );
  #persistedUserMessageResponseIds = new Set<string>();
  /**
   * MessageIds already written as `partial: true` records (abort/error path).
   * Enforces "one message, one durable record": the partial write is the
   * authoritative durable copy for that message, so a later non-partial
   * re-emission of the same messageId (the terminal drain) is suppressed.
   */
  #partialRecordedMessageIds = new Set<string>();

  constructor(
    state: StateTree,
    opts?: Map<SessionType, SessionTypeHandler> | SessionManagerOptions,
  ) {
    this.#state = state;
    if (opts instanceof Map) {
      this.#handlers = opts;
    } else {
      this.#handlers = createDefaultHandlers();
      if (opts?.runStatusSink) {
        if (opts.agentId === undefined) {
          throw new Error(
            'SessionManager: runStatusSink requires agentId — sink events carry the agent scope',
          );
        }
        this.#runStatusScope = { sink: opts.runStatusSink, agentId: opts.agentId };
      }
    }
  }

  /** Register or replace a handler for a session type. */
  registerHandler(handler: SessionTypeHandler): void {
    this.#handlers.set(handler.type, handler);
  }

  /** Get the handler for a session type. */
  getHandler(type: SessionType): SessionTypeHandler | undefined {
    return this.#handlers.get(type);
  }

  /**
   * Get or create a session. If the session doesn't exist, creates it with
   * the given type and idle status.
   * @param name Optional human-readable name. Ignored if session already exists.
   */
  async getOrCreate(sessionId: string, type: SessionType, name?: string): Promise<SessionSummary> {
    const node = this.#state.sessions.get(sessionId).summary;
    if (!node.loaded) {
      await node.load();
    }
    if (node.data) {
      return node.data as SessionSummary;
    }

    const now = new Date().toISOString();
    const summary: SessionSummary = {
      sessionId,
      type,
      status: 'idle',
      messageCount: 0,
      ...(name ? { name } : {}),
      createdAt: now,
      lastActiveAt: now,
    };

    await node.set(summary);
    return summary;
  }

  /** Get a session by ID. Returns null if not found. */
  async get(sessionId: string): Promise<SessionSummary | null> {
    const node = this.#state.sessions.get(sessionId).summary;
    if (!node.loaded) {
      await node.load();
    }
    return (node.data as SessionSummary) ?? null;
  }

  /** Update session status and touch lastActiveAt. */
  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const summary = await this.get(sessionId);
    if (!summary) {
      console.warn('[SessionManager] updateStatus: session not found', { sessionId, status });
      return;
    }

    const updated: SessionSummary = {
      ...summary,
      status,
      lastActiveAt: new Date().toISOString(),
    };

    await this.#state.sessions.get(sessionId).summary.set(updated);
  }

  /** Write currentRun = 'processing' at turn start. Must be awaited before output begins. */
  async setCurrentRun(
    sessionId: string,
    opts: { responseId: string; startedAt: number },
  ): Promise<void> {
    this.#lastContentSeqBySession.delete(sessionId);
    if (this.#runStatusScope) {
      const { sink, agentId } = this.#runStatusScope;
      await sink.onRunProcessing({
        agentId,
        sessionId,
        responseId: opts.responseId,
        startedAt: opts.startedAt,
      });
      return;
    }
    const currentRun: CurrentRun = {
      status: 'processing',
      responseId: opts.responseId,
      startedAt: opts.startedAt,
    };
    await this.#state.sessions.get(sessionId).node.at('currentRun').set(currentRun);
  }

  /** Writes a terminal status only if the run is still 'processing' for this responseId (idempotent). */
  async finalizeCurrentRun(
    sessionId: string,
    responseId: string,
    terminalStatus: 'idle' | 'error',
  ): Promise<void> {
    if (this.#runStatusScope) {
      const { sink, agentId } = this.#runStatusScope;
      await sink.onRunTerminal({ agentId, sessionId, responseId, status: terminalStatus });
      return;
    }
    const node = this.#state.sessions.get(sessionId).node.at('currentRun');
    if (!node.loaded) {
      await node.load();
    }
    const existing = node.data as CurrentRun | null | undefined;
    if (!existing) {
      return;
    }
    if (existing.status !== 'processing') {
      return;
    }
    if (existing.responseId !== responseId) {
      return;
    }

    const updated: CurrentRun = { ...existing, status: terminalStatus };
    await node.set(updated);
  }

  /** Update session summary fields (partial update, merges with existing). */
  async update(
    sessionId: string,
    fields: Partial<Omit<SessionSummary, 'sessionId' | 'createdAt'>>,
  ): Promise<void> {
    const summary = await this.get(sessionId);
    if (!summary) {
      console.warn('[SessionManager] update: session not found', { sessionId });
      return;
    }

    const updated: SessionSummary = {
      ...summary,
      ...fields,
      lastActiveAt: fields.lastActiveAt ?? new Date().toISOString(),
    };

    await this.#state.sessions.get(sessionId).summary.set(updated);
  }

  /**
   * Record the engine a session is about to run with (`lastEngine`). Skips the
   * write when unchanged, so the common repeat case costs one cached read.
   * Callers should treat this as best-effort — a failed stamp must not fail
   * the run.
   */
  async recordEngine(sessionId: string, engine: string): Promise<void> {
    const summary = await this.get(sessionId);
    if (!summary || summary.lastEngine === engine) {
      return;
    }
    await this.update(sessionId, { lastEngine: engine });
  }

  /** Record the owner-facing Builder model without changing a role's raw engine. */
  async recordBuilderModel(sessionId: string, model: string): Promise<void> {
    const summary = await this.get(sessionId);
    if (!summary || summary.lastBuilderModel === model) {
      return;
    }
    await this.update(sessionId, { lastBuilderModel: model });
  }

  /**
   * Append a message to a session's LLM history (MSG# record).
   *
   * UI content (CONTENT#) is no longer derived here — it is captured from the
   * agent's content stream and persisted via `recordContent`. Naming is
   * delegated to the SessionTypeHandler registered for the session's type.
   */
  async appendMessage(sessionId: string, message: ConversationMessage): Promise<number> {
    const sessionNode = this.#state.sessions.get(sessionId);
    const seq = await sessionNode.messages.append(message);

    this.#lastSeqBySession.set(sessionId, seq);

    if (message.role === 'user' || message.role === 'assistant') {
      const summaryNode = sessionNode.summary;
      if (!summaryNode.loaded) {
        await summaryNode.load();
      }
      const summary = summaryNode.data as SessionSummary | undefined;
      if (summary) {
        const updates: Partial<SessionSummary> = {};
        // Stamp the count on the session's FIRST message so an aborted or
        // crashed run can never leave a message-bearing session looking empty
        // (finalizeSession owns the count from an in-memory seq that a restart
        // loses — see "reused Untitled chat" bug). Later messages stay
        // finalize-only to keep the per-message write amplification out.
        if ((summary.messageCount ?? 0) === 0) {
          updates.messageCount = seq;
        }
        if (!summary.nameSource) {
          const handler = this.#handlers.get(summary.type);
          const newName = handler ? await handler.resolveSessionName(summary, message) : undefined;
          if (newName !== undefined) {
            const truncated = truncateSessionName(newName);
            if (truncated !== summary.name) {
              updates.name = truncated;
            }
          }
        }
        if (Object.keys(updates).length > 0) {
          await summaryNode.set({ ...summary, ...updates });
        }
      }
    }

    return seq;
  }

  /**
   * Write the session's message count + lastActiveAt once, at run completion.
   * The per-message version of this (in appendMessage) was removed to avoid a
   * summary/SESS# write per message.
   */
  async finalizeSession(sessionId: string): Promise<void> {
    const summaryNode = this.#state.sessions.get(sessionId).summary;
    if (!summaryNode.loaded) {
      await summaryNode.load();
    }
    const summary = summaryNode.data as SessionSummary | undefined;
    if (!summary) {
      return;
    }
    const lastSeq = this.#lastSeqBySession.get(sessionId) ?? 0;
    await summaryNode.set({
      ...summary,
      messageCount: Math.max(lastSeq, summary.messageCount ?? 0),
      lastActiveAt: new Date().toISOString(),
    });
  }

  /**
   * Record an emitted message batch to the session, off the caller's path
   * (ordered, fire-and-forget). The default consumer of an agent's onMessages.
   */
  recordMessages(sessionId: string, event: AgentMessages): void {
    const task = this.#messageRecordTask(sessionId, event);
    if (!task) {
      return;
    }
    this.#recordQueue.enqueue(task);
  }

  /** Record a message batch in queue order and resolve when its durable writes finish. */
  recordMessagesAndWait(sessionId: string, event: AgentMessages): Promise<void> {
    const task = this.#messageRecordTask(sessionId, event);
    return task ? this.#recordQueue.enqueueAndWait(task) : Promise.resolve();
  }

  #messageRecordTask(sessionId: string, event: AgentMessages): (() => Promise<void>) | null {
    if (event.messages.length === 0) {
      return null;
    }
    const { messages, responseId, pendingToolCallIds } = event;
    return async () => {
      const records = toPersistableMessages(messages, {
        responseId,
        pendingToolCallIds,
      });
      for (const record of records) {
        await this.appendMessage(sessionId, record);
      }
    };
  }

  /** Await all queued recording writes — call at run completion. */
  flushRecording(): Promise<void> {
    return this.#recordQueue.drain();
  }

  /**
   * Merge blocking-tool resolutions into the session's durable record, off the
   * caller's path (ordered with message writes on the record queue, so a
   * subsequent loadConversation's flushRecording sees them). A stored click
   * output is never downgraded to a text-bypass null.
   */
  recordResolvedToolResults(sessionId: string, resolutions: ResolvedToolResults): void {
    if (Object.keys(resolutions).length === 0) {
      return;
    }
    this.#recordQueue.enqueue(async () => {
      const node = this.#state.sessions.get(sessionId).resolvedToolResults;
      // Force a fresh read: the builder reuses a warm per-instance StateTree, so a
      // cached node can miss another instance's durable write and regress the merge.
      await node.load({ force: true });
      const existing = node.data ?? {};
      const merged: ResolvedToolResults = { ...existing };
      for (const [toolCallId, output] of Object.entries(resolutions)) {
        if (output === null && typeof merged[toolCallId] === 'string') {
          continue;
        }
        merged[toolCallId] = output;
      }
      await node.set(merged);
    });
  }

  /** Load the session's accumulated blocking-tool resolutions ({} when none recorded). */
  async loadResolvedToolResults(sessionId: string): Promise<ResolvedToolResults> {
    await this.flushRecording();
    const node = this.#state.sessions.get(sessionId).resolvedToolResults;
    // Force a fresh read so a warm cross-instance node cannot serve a stale map.
    await node.load({ force: true });
    return node.data ?? {};
  }

  /**
   * Record a batch of finalized UI content items to the session's CONTENT#
   * collection, off the caller's path (ordered, fire-and-forget). The default
   * consumer of an agent's onContent. Conversion is synchronous so the record
   * snapshots state at emit time (the source reducer reuses item objects).
   */
  /**
   * Declare that the user message for a run is already durable (write-ahead
   * ingress persistence): `recordContent` will skip user-role items carrying
   * this responseId so the CONTENT# record is written exactly once, regardless
   * of which writer ran first.
   */
  markUserMessagePersisted(responseId: string): void {
    this.#persistedUserMessageResponseIds.add(responseId);
  }

  #isUserMessageAlreadyPersisted(record: PersistedContentItem): boolean {
    return (
      record.role === 'user' &&
      record.responseId !== undefined &&
      this.#persistedUserMessageResponseIds.has(record.responseId)
    );
  }

  /**
   * True when a non-partial record duplicates a messageId already persisted
   * via a `partial: true` write — the late re-emission must be skipped so the
   * message keeps exactly one durable CONTENT# record (the marked one).
   */
  #isDuplicateOfPartialRecord(record: PersistedContentItem, partial: true | undefined): boolean {
    return !partial && this.#partialRecordedMessageIds.has(record.messageId);
  }

  recordContent(sessionId: string, event: AgentContentEvent): void {
    const records = this.#contentRecords(event);
    if (records.length === 0) {
      return;
    }
    this.#contentRecordQueue.enqueue(this.#contentRecordTask(sessionId, records));
  }

  /** Record a content batch in queue order and resolve when its durable writes finish. */
  recordContentAndWait(sessionId: string, event: AgentContentEvent): Promise<void> {
    const records = this.#contentRecords(event);
    if (records.length === 0) {
      return Promise.resolve();
    }
    return this.#contentRecordQueue.enqueueAndWait(this.#contentRecordTask(sessionId, records));
  }

  #contentRecords(event: AgentContentEvent): PersistedContentItem[] {
    const records: PersistedContentItem[] = [];
    for (const item of event.items) {
      const record = toPersistedContentItem(item);
      if (
        record &&
        !this.#isUserMessageAlreadyPersisted(record) &&
        !this.#isDuplicateOfPartialRecord(record, event.partial)
      ) {
        if (event.partial) {
          this.#partialRecordedMessageIds.add(record.messageId);
          records.push({ ...record, partial: true });
        } else {
          records.push(record);
        }
      }
    }
    return records;
  }

  #contentRecordTask(sessionId: string, records: PersistedContentItem[]): () => Promise<void> {
    return async () => {
      for (const record of records) {
        const seq = await this.appendContent(sessionId, record);
        this.#lastContentSeqBySession.set(sessionId, seq);
      }
    };
  }

  /** Await all queued content writes — call at run completion. */
  flushContentRecording(): Promise<void> {
    return this.#contentRecordQueue.drain();
  }

  /**
   * Stamp the run's completion cursor onto the current-run record: the highest
   * CONTENT# seq this SessionManager recorded for the current run (the tracker
   * resets on every `setCurrentRun`). Drains pending content writes itself
   * before reading the cursor, so callers need not flush first. Clients sweep
   * committed content up to this cursor instead of guessing with timed retries.
   * Delegates to the RunStatusSink when one is injected (builder mode — the
   * host owns durable currentRun writes); otherwise writes the node directly.
   * No-ops when the node belongs to a different response or the run recorded
   * nothing (legacy fallback sweeps cover that).
   */
  async stampFinalContentSeq(sessionId: string, responseId: string): Promise<void> {
    await this.flushContentRecording();
    const finalContentSeq = this.#lastContentSeqBySession.get(sessionId);
    if (finalContentSeq === undefined) {
      return;
    }
    if (this.#runStatusScope) {
      const { sink, agentId } = this.#runStatusScope;
      await sink.onRunContentFlushed({ agentId, sessionId, responseId, finalContentSeq });
      return;
    }
    const node = this.#state.sessions.get(sessionId).node.at('currentRun');
    if (!node.loaded) {
      await node.load();
    }
    const existing = node.data as CurrentRun | null | undefined;
    if (!existing || existing.responseId !== responseId) {
      return;
    }
    const updated: CurrentRun = { ...existing, finalContentSeq };
    await node.set(updated);
  }

  /**
   * Write a pending builder-run event to `/inbox/builder-runs/<sessionId>/<eventId>`.
   * Inbox entries are TOP-LEVEL edges around the session record, never nested
   * inside it (UNIFIED_AGENT_RUNTIME_DIRECTION — per-session inboxes are
   * explicitly rejected); the kind-scoped nesting mirrors
   * `/inbox/channels/{type}/{id}/…`.
   */
  async appendInboxEvent(sessionId: string, event: SessionInboxEvent): Promise<void> {
    await this.#state.set(this.#inboxEventPath(sessionId, event.id), event);
  }

  /** Pending builder-run events targeting a session, FIFO by createdAt (id tiebreak). */
  async listInboxEvents(sessionId: string): Promise<SessionInboxEvent[]> {
    const paths = await this.#state.list(`/inbox/builder-runs/${sessionId}/`);
    const events: SessionInboxEvent[] = [];
    for (const path of paths) {
      const value = await this.#state.get<SessionInboxEvent>(path);
      if (value && typeof value.id === 'string' && typeof value.text === 'string') {
        events.push(value);
      }
    }
    events.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return events;
  }

  /** Ack-by-delete: a consumed inbox event is removed (channel-handler precedent). */
  async removeInboxEvent(sessionId: string, eventId: string): Promise<void> {
    await this.#state.delete(this.#inboxEventPath(sessionId, eventId));
  }

  /** Persist a changed event in place (e.g. flagging `needsUser`). */
  async updateInboxEvent(sessionId: string, event: SessionInboxEvent): Promise<void> {
    await this.#state.set(this.#inboxEventPath(sessionId, event.id), event);
  }

  #inboxEventPath(sessionId: string, eventId: string): string {
    return `/inbox/builder-runs/${sessionId}/${eventId}`;
  }

  /**
   * Append a UI content item to a session's content collection.
   *
   * Content items are finalized UI state — what the client renders on reload.
   * Stored as CONTENT# records, append-only, never compacted.
   * Does NOT update session summary (content is UI-only, not LLM state).
   */
  async appendContent(sessionId: string, item: PersistedContentItem): Promise<number> {
    const seq = await this.#state.sessions.get(sessionId).content.append(item);
    return seq;
  }

  /**
   * Load all UI content items for a session. Returns items sorted by
   * sequence number (append order). Returns empty array if no content
   * exists (pre-content-persistence sessions or new sessions).
   */
  async loadContent(sessionId: string): Promise<AgentContent[]> {
    await this.flushContentRecording();
    const contentNode = this.#state.sessions.get(sessionId).content;
    if (!contentNode.loaded) {
      // Cap at 10k items. Content is append-only so long sessions could
      // accumulate more, but in practice a 5000-tool-call session is extreme.
      // If this cap is hit, revisit with cursor-based pagination.
      await contentNode.load({ limit: 10000 });
    }
    const items = [...contentNode.children.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, n]) => n.data as PersistedContentItem);

    const contents: AgentContent[] = [];
    for (const item of items) {
      const content = toAgentContent(item);
      if (content) {
        contents.push(content);
      }
    }
    return contents;
  }

  /**
   * Write a compaction snapshot — persists the compacted kernel so it
   * survives restarts. Both builder and deployed agents use this.
   *
   * Passes this manager's append watermark as the snapshot coverage boundary
   * so messages appended concurrently by another writer (with higher seqs)
   * stay in the WAL instead of being marked as covered-but-absent.
   */
  async writeSnapshot(
    sessionId: string,
    messages: Record<string, unknown>[],
  ): Promise<{ snapshotSeq: number }> {
    return this.#state.backend.writeSessionSnapshot(
      sessionId,
      messages,
      this.#lastSeqBySession.get(sessionId),
    );
  }

  /** Load conversation messages for a session. Sorted by sequence number. */
  async loadConversation(sessionId: string): Promise<ConversationMessage[]> {
    // Reading the WAL mid-drain yields orphaned tool calls that HistoryDoctor
    // would "repair" with synthetic results — drain our own writes first.
    await this.flushRecording();

    // Try snapshot + WAL loading first (fast path for sessions with compaction snapshots)
    const snapshotResult = await this.#state.backend.loadSession(sessionId);
    if (snapshotResult !== null) {
      // Trust the result even when empty — backend already completed the scan.
      // Returning early prevents a second redundant DDB scan for new/pre-snapshot sessions.
      return snapshotResult.messages;
    }

    // Fallback: backend returned null (e.g. RpcStateBackend doesn't implement loadSession).
    const messagesNode = this.#state.sessions.get(sessionId).messages;
    if (!messagesNode.loaded) {
      await messagesNode.load({ limit: 1000 });
    }
    const allMessages = [...messagesNode.children.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, n]) => n.data as ConversationMessage);

    // Checkpoint rows are markers for snapshot-capable backends. On this
    // fallback path the snapshot that holds the kept hot zone is unreadable,
    // so slicing at the checkpoint would drop the kept-recent messages —
    // replay the full WAL instead and hide the marker rows.
    return allMessages.filter((msg) => !isCheckpointMessage(msg));
  }

  /**
   * Latest compaction record for a session, or null when it never compacted.
   *
   * Reads the raw WAL rather than `loadConversation`, which cannot serve this:
   * on the snapshot path it returns the collapsed messages, and on the fallback
   * path it deliberately FILTERS checkpoint rows out. The record is therefore
   * invisible to every existing reader — it has been write-only since it was
   * introduced.
   *
   * The boundary comes back as a `mid`, which is why it can be verified in the
   * lab at all: a storage seq would only be meaningful against real DDB.
   */
  async loadLatestCompactionRecord(
    sessionId: string,
  ): Promise<{ summary: string | null; firstKeptMid: string | null } | null> {
    const messagesNode = this.#state.sessions.get(sessionId).messages;
    if (!messagesNode.loaded) {
      await messagesNode.load({ limit: 1000 });
    }
    const ordered = [...messagesNode.children.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, n]) => n.data as ConversationMessage);

    for (let i = ordered.length - 1; i >= 0; i--) {
      const message = ordered[i];
      const data = readCheckpointData(message);
      if (data === null) {
        continue;
      }
      return { summary: data.summary, firstKeptMid: data.firstKeptMid ?? null };
    }
    return null;
  }

  /** Load only messages added after a given sequence number (incremental load). */
  async loadMessagesSince(sessionId: string, afterSeq: number): Promise<ConversationMessage[]> {
    // Force reload to get latest messages
    const messagesNode = this.#state.sessions.get(sessionId).messages;
    await messagesNode.load({ limit: 1000, force: true });
    const allMessages = [...messagesNode.children.entries()];
    return allMessages
      .filter(([key]) => {
        const seq = parseInt(key, 10);
        return seq > afterSeq;
      })
      .map(([, node]) => node.data as ConversationMessage);
  }

  /** Append an activity entry to a session's activity log. */
  async logActivity(sessionId: string, entry: ActivityEntry): Promise<void> {
    const id = generateShortId(6);
    const path = `/sessions/${sessionId}/activity/${entry.timestamp}_${id}`;
    await this.#state.at(path).set(entry);
  }

  /** Get the activity log for a session. */
  async getActivity(sessionId: string): Promise<ActivityEntry[]> {
    const activityNode = this.#state.sessions.get(sessionId).activity;
    await activityNode.load({ depth: 1 });
    const entries = [...activityNode.children.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, node]) => node.data as ActivityEntry)
      .filter(Boolean);
    return entries;
  }

  /** Delete a session — removes summary, all messages, and activity entries. */
  async delete(sessionId: string): Promise<void> {
    await this.#state.sessions.get(sessionId).delete();
  }

  /** List all sessions for this agent. */
  async listSessions(): Promise<SessionSummary[]> {
    return this.#state.sessions.list();
  }

  /** No-op — state tree owns cache and subscription lifecycle. */
  evictFromCache(_sessionId: string): void {}

  /** No-op — state tree owns cache lifecycle. */
  clearCache(): void {}

  /** No-op — state tree owns subscription lifecycle. */
  dispose(): void {}
}
