import type { IStateTransport } from './state-connection.ts';
import {
  StateBackend,
  type ConversationMessage,
  type StateChangeEvent,
  type Unsubscribe,
  type ScopeEntry,
  type SyncResult,
} from './types.ts';
import { isCheckpointMessage } from '../sessions/checkpoint.ts';
import { getAgentLogger } from '../types/logger.ts';

const logger = getAgentLogger();

/**
 * RpcStateBackend — production backend that talks to Platform Server via RpcPeer.
 *
 * All persistence happens server-side (DynamoDB). This backend is a thin RPC proxy.
 * Remote change notifications arrive via RpcPeer notify() from the server.
 *
 * Phase 2.5: On reconnect, performs a sync to recover missed changes using
 * the server's MemoryDB changelog. Buffers notifications during sync to avoid
 * gaps from the subscribe-before-read pattern.
 */
export class RpcStateBackend extends StateBackend {
  #transport: IStateTransport;
  #listeners = new Set<(event: StateChangeEvent) => void>();
  #cacheResetListeners = new Set<() => void>();
  #connected = false;

  // Phase 2.5: State sync on reconnect
  #lastChangeSeq = 0;
  #hasReceivedConnected = false;
  #syncing = false;
  #syncBuffer: StateChangeEvent[] = [];
  #syncPromise: Promise<void> | null = null;
  #handlerRegistered = false;
  #onReconnect: (() => void) | null = null;

  /** Default timeout for RPC operations (prevents permanent hangs). */
  static readonly RPC_TIMEOUT_MS = 15_000;

  constructor(transport: IStateTransport) {
    super();
    this.#transport = transport;
  }

  #ask<T>(payload: unknown): Promise<T> {
    return this.#transport.ask<T>(payload, { timeout: RpcStateBackend.RPC_TIMEOUT_MS });
  }

  override async get<T>(path: string): Promise<T | null> {
    const result = await this.#ask<{ value: T | null }>({
      type: 'state:get',
      path,
    });
    return result.value ?? null;
  }

  override async set<T>(path: string, value: T): Promise<void> {
    await this.#ask({ type: 'state:set', path, value });
  }

  override async delete(path: string): Promise<void> {
    await this.#ask({ type: 'state:delete', path });
  }

  override async list(prefix: string): Promise<string[]> {
    const result = await this.#ask<{ paths: string[] }>({
      type: 'state:list',
      prefix,
    });
    return result.paths;
  }

  override async append(prefix: string, value: unknown): Promise<{ seq: number }> {
    return this.#ask<{ seq: number }>({
      type: 'state:append',
      prefix,
      value,
    });
  }

  override async load(
    prefix: string,
    options?: { limit?: number; depth?: number },
  ): Promise<{ entries: Record<string, unknown> }> {
    return this.#ask<{ entries: Record<string, unknown> }>({
      type: 'state:load',
      prefix,
      ...(options?.limit != null && { limit: options.limit }),
      ...(options?.depth != null && { depth: options.depth }),
    });
  }

  override async writeSessionSnapshot(
    sessionId: string,
    messages: Record<string, unknown>[],
    coveredSeq?: number,
  ): Promise<{ snapshotSeq: number }> {
    const seq = coveredSeq ?? 0;
    await this.set(`/sessions/${sessionId}/snapshot`, { seq, messages });
    return { snapshotSeq: seq };
  }

  /**
   * Assemble the conversation as compacted-kernel snapshot + the WAL tail
   * appended after the snapshot's coverage watermark, mirroring the builder's
   * DirectStateBackend. Returns null (caller falls back to a full replay)
   * when no snapshot exists.
   */
  override async loadSession(
    sessionId: string,
  ): Promise<{ messages: ConversationMessage[]; snapshotSeq: number | null } | null> {
    const snap = await this.get<{ seq: number; messages: Record<string, unknown>[] }>(
      `/sessions/${sessionId}/snapshot`,
    );
    if (!snap || typeof snap.seq !== 'number' || !Array.isArray(snap.messages)) {
      return null;
    }

    const { messages: walRecords } = await this.#ask<{ messages: Record<string, unknown>[] }>({
      type: 'state:load-conversation',
      sessionId,
      afterSeq: snap.seq,
    });

    const kernel: ConversationMessage[] = snap.messages.map((data) => ({
      role: isConversationRole(data.role) ? data.role : 'assistant',
      timestamp: new Date().toISOString(),
      data,
    }));
    const tail = (walRecords ?? [])
      .map(toConversationMessage)
      .filter((msg) => !isCheckpointMessage(msg));
    return { messages: [...kernel, ...tail], snapshotSeq: snap.seq };
  }

  /** Register a callback to be called on reconnect instead of default sync. */
  setReconnectHandler(handler: () => void): void {
    this.#onReconnect = handler;
  }

  /** The last known change sequence number (for scoped sync). */
  get lastChangeSeq(): number {
    return this.#lastChangeSeq;
  }

  /** Send a scoped sync request to the server. */
  override async syncWithScope(lastChangeSeq: number, scope: ScopeEntry[]): Promise<SyncResult> {
    this.#syncing = true;
    this.#syncBuffer = [];

    try {
      const result = await this.#ask<SyncResult>({
        type: 'state:sync',
        lastChangeSeq,
        scope,
      });

      this.#lastChangeSeq = Math.max(this.#lastChangeSeq, result.lastChangeSeq);
      return result;
    } finally {
      this.#syncing = false;
      this.#drainBuffer();
    }
  }

  override onRemoteChange(handler: (event: StateChangeEvent) => void): Unsubscribe {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  override onCacheReset(handler: () => void): Unsubscribe {
    this.#cacheResetListeners.add(handler);
    return () => this.#cacheResetListeners.delete(handler);
  }

  override async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    this.#connected = true;

    if (this.#handlerRegistered) {
      return;
    }
    this.#handlerRegistered = true;

    // Listen for notifications pushed by the server
    this.#transport.onNotify((message: unknown) => {
      const msg = message as Record<string, unknown>;
      logger.debug('[RpcStateBackend] onNotify received', {
        type: msg.type,
        path: msg.path,
        change: msg.change,
        changeSeq: msg.changeSeq,
        syncing: this.#syncing,
        listeners: this.#listeners.size,
      });

      // Server sends { type: 'connected' } on each WebSocket connection.
      // On first connect: no sync needed (cache is empty, reads fetch on demand).
      // On reconnect: trigger sync to recover missed changes.
      if (msg.type === 'connected') {
        const isReconnect = this.#hasReceivedConnected;
        logger.debug('[RpcStateBackend] Received "connected" notification', {
          isReconnect,
          lastChangeSeq: this.#lastChangeSeq,
        });
        if (isReconnect) {
          if (this.#onReconnect) {
            this.#onReconnect();
          } else {
            this.#syncState();
          }
        }
        this.#hasReceivedConnected = true;
        return;
      }

      if (msg.type === 'state:changed') {
        const event: StateChangeEvent = {
          path: msg.path as string,
          change: msg.change as 'set' | 'delete',
          value: msg.value,
          source: 'remote',
          timestamp: (msg.timestamp as string) || new Date().toISOString(),
          changeSeq: msg.changeSeq as number | undefined,
        };

        // During sync, buffer notifications to drain after sync completes.
        // Don't update #lastChangeSeq here — dedup happens in #drainBuffer.
        if (this.#syncing) {
          this.#syncBuffer.push(event);
          return;
        }

        // Track changeSeq for sync (only for delivered events)
        if (event.changeSeq) {
          this.#lastChangeSeq = Math.max(this.#lastChangeSeq, event.changeSeq);
        }

        this.#fireListeners(event);
      }
    });
  }

  override disconnect(): void {
    this.#connected = false;
    // WebSocket lifecycle is managed externally by StateConnection
  }

  #fireListeners(event: StateChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[RpcStateBackend] Listener error:', err);
      }
    }
  }

  /**
   * Sync state after reconnect. Sends the last known changeSeq to the server,
   * which responds with either a diff (individual changes) or a full snapshot.
   */
  async #syncState(): Promise<void> {
    // Guard against concurrent syncs from rapid reconnects
    if (this.#syncPromise) {
      logger.debug('[RpcStateBackend] Sync already in progress, skipping');
      return;
    }
    this.#syncPromise = this.#doSync();
    try {
      await this.#syncPromise;
    } finally {
      this.#syncPromise = null;
    }
  }

  async #doSync(): Promise<void> {
    logger.debug('[RpcStateBackend] Starting sync', {
      lastChangeSeq: this.#lastChangeSeq,
    });
    this.#syncing = true;
    this.#syncBuffer = [];

    try {
      const result = await this.#ask<{
        type: 'state:diff' | 'state:snapshot';
        changes?: Array<{
          path: string;
          change: 'set' | 'delete';
          value?: unknown;
          changeSeq: number;
        }>;
        entries?: Record<string, unknown>;
        lastChangeSeq: number;
      }>({
        type: 'state:sync',
        lastChangeSeq: this.#lastChangeSeq,
      });

      if (result.type === 'state:snapshot') {
        const inboxPaths = Object.keys(result.entries ?? {}).filter((p) => p.startsWith('/inbox/'));
        logger.debug('[RpcStateBackend] Sync received full snapshot', {
          totalEntries: Object.keys(result.entries ?? {}).length,
          inboxEntries: inboxPaths.length,
          inboxPaths,
          lastChangeSeq: result.lastChangeSeq,
        });
        // Full snapshot — notify cache reset, then fire set events for all entries
        for (const handler of this.#cacheResetListeners) {
          try {
            handler();
          } catch (err) {
            console.error('[RpcStateBackend] Cache reset handler error:', err);
          }
        }

        for (const [path, value] of Object.entries(result.entries ?? {})) {
          this.#fireListeners({
            path,
            change: 'set',
            value,
            source: 'remote',
            timestamp: new Date().toISOString(),
            changeSeq: result.lastChangeSeq,
          });
        }
      } else if (result.type === 'state:diff') {
        const inboxChanges = (result.changes ?? []).filter((c) => c.path.startsWith('/inbox/'));
        logger.debug('[RpcStateBackend] Sync received diff', {
          totalChanges: (result.changes ?? []).length,
          inboxChanges: inboxChanges.length,
          inboxPaths: inboxChanges.map((c) => c.path),
          lastChangeSeq: result.lastChangeSeq,
        });
        // Apply individual changes
        for (const change of result.changes ?? []) {
          this.#fireListeners({
            path: change.path,
            change: change.change,
            value: change.value,
            source: 'remote',
            timestamp: new Date().toISOString(),
            changeSeq: change.changeSeq,
          });
        }
      }

      this.#lastChangeSeq = Math.max(this.#lastChangeSeq, result.lastChangeSeq);
    } catch (err) {
      console.error('[RpcStateBackend] Sync failed:', err);
    } finally {
      this.#syncing = false;
      this.#drainBuffer();
    }
  }

  /**
   * Drain buffered notifications received during sync.
   * Skips events already covered by the sync result (dedup by changeSeq).
   */
  #drainBuffer(): void {
    if (this.#syncBuffer.length > 0) {
      const inboxEvents = this.#syncBuffer.filter((e) => e.path.startsWith('/inbox/'));
      logger.debug('[RpcStateBackend] Draining sync buffer', {
        totalBuffered: this.#syncBuffer.length,
        inboxBuffered: inboxEvents.length,
        lastChangeSeq: this.#lastChangeSeq,
      });
    }
    for (const event of this.#syncBuffer) {
      if (event.changeSeq && event.changeSeq <= this.#lastChangeSeq) {
        continue;
      }
      if (event.changeSeq) {
        this.#lastChangeSeq = Math.max(this.#lastChangeSeq, event.changeSeq);
      }
      this.#fireListeners(event);
    }
    this.#syncBuffer = [];
  }
}

function isConversationRole(v: unknown): v is ConversationMessage['role'] {
  return v === 'user' || v === 'assistant' || v === 'system' || v === 'tool';
}

function toConversationMessage(record: Record<string, unknown>): ConversationMessage {
  const msg: ConversationMessage = {
    role: isConversationRole(record.role) ? record.role : 'assistant',
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
    data: record.data,
  };
  if (typeof record.responseId === 'string') {
    msg.responseId = record.responseId;
  }
  return msg;
}
