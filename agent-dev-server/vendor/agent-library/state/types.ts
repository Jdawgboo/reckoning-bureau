/**
 * State store types — shared between StateTree, backends, and scoped views.
 */

/** A change event emitted by the store when a path is set or deleted. */
export interface StateChangeEvent {
  /** Full path of the changed key */
  path: string;
  /** Type of change */
  change: 'set' | 'delete';
  /** The new value (present for 'set', absent for 'delete') */
  value?: unknown;
  /** Who made the change */
  source: 'local' | 'remote';
  /** When the change occurred (ISO 8601) */
  timestamp: string;
  /** Monotonic sequence number for ordering (set by server when changelog is available) */
  changeSeq?: number;
}

/** Unsubscribe function returned by subscribe(). */
export type Unsubscribe = () => void;

/** Path access rule for scoped views. */
export interface PathRule {
  /** Glob pattern for the path scope */
  path: string;
  /** Access mode */
  mode: 'rw' | 'ro';
}

/**
 * StateBackend — pluggable persistence layer for the state tree.
 *
 * Custom backends need only implement 5 abstract methods: get, set, delete, list, append.
 * Everything else has sensible defaults:
 * - load() defaults to list() + get() (override for batch optimization)
 * - connect/disconnect are no-ops (override for network backends)
 * - onRemoteChange/onCacheReset are no-ops (override for real-time sync)
 *
 * Built-in implementations:
 * - InMemoryStateBackend: unit tests, local dev without server
 * - RpcStateBackend: production — talks to Platform Server via RpcPeer WebSocket
 */
export abstract class StateBackend {
  /** Read a value from the persistent store. */
  abstract get<T>(path: string): Promise<T | null>;
  /** Write a value to the persistent store. */
  abstract set<T>(path: string, value: T): Promise<void>;
  /** Delete a value from the persistent store. */
  abstract delete(path: string): Promise<void>;
  /** List child paths under a prefix. */
  abstract list(prefix: string): Promise<string[]>;
  /**
   * Append a value to a collection at the given prefix.
   * Returns the assigned sequence number. Must be atomic (no race conditions).
   */
  abstract append(prefix: string, value: unknown): Promise<{ seq: number }>;

  /**
   * Write a compaction snapshot for a session.
   * Default: no-op (backends that support snapshots override this).
   *
   * `coveredSeq` is the highest WAL seq actually contained in `messages` —
   * the caller's append watermark. Backends must record it as the snapshot's
   * coverage boundary rather than querying the current max seq at write time,
   * which would mark concurrently appended rows as covered and drop them on
   * rebuild.
   */
  async writeSessionSnapshot(
    _sessionId: string,
    _messages: Record<string, unknown>[],
    _coveredSeq?: number,
  ): Promise<{ snapshotSeq: number }> {
    return { snapshotSeq: 0 };
  }

  /**
   * Load a session using snapshot + WAL pattern.
   * Default: returns null (falls back to regular loadConversation in SessionManager).
   */
  async loadSession(
    _sessionId: string,
  ): Promise<{ messages: ConversationMessage[]; snapshotSeq: number | null } | null> {
    return null;
  }

  /**
   * Batch-load a subtree. Returns all entries under the prefix.
   * Default: list() + individual get() calls. Override for batch optimization.
   */
  async load(
    prefix: string,
    options?: { limit?: number; depth?: number },
  ): Promise<{ entries: Record<string, unknown> }> {
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    let paths = await this.list(normalizedPrefix);

    // Apply depth filtering
    if (options?.depth != null) {
      const maxDepth = options.depth;
      paths = paths.filter((p) => {
        const relative = p.slice(normalizedPrefix.length);
        const segments = relative.split('/').filter(Boolean);
        return segments.length <= maxDepth;
      });
    }

    // Apply limit (last N entries)
    if (options?.limit != null && options.limit > 0 && paths.length > options.limit) {
      paths.sort();
      paths = paths.slice(-options.limit);
    }

    const entries: Record<string, unknown> = {};
    await Promise.all(
      paths.map(async (path) => {
        const value = await this.get(path);
        if (value !== null) {
          entries[path] = value;
        }
      }),
    );
    return { entries };
  }

  /**
   * Listen for remote changes (changes made by others, not by this client).
   * Default: no-op (single-instance backends don't have remote changes).
   */
  onRemoteChange(_handler: (event: StateChangeEvent) => void): Unsubscribe {
    return () => {};
  }

  /** Connect to the remote store. Default: no-op. */
  async connect(): Promise<void> {}

  /** Disconnect from the remote store. Default: no-op. */
  disconnect(): void {}

  /**
   * Register a handler called when the backend performs a full cache reset
   * (e.g., on reconnect with a full snapshot sync).
   * Default: no-op.
   */
  onCacheReset(_handler: () => void): Unsubscribe {
    return () => {};
  }

  /**
   * Sync with hydration scope — only sync previously-loaded prefixes.
   * Override in network backends to send scope to the server.
   * Default: falls back to regular unscoped sync (via connect/onRemoteChange).
   */
  async syncWithScope(_lastChangeSeq: number, _scope: ScopeEntry[]): Promise<SyncResult> {
    // Default: no-op. Network backends override this.
    return { type: 'state:snapshot', entries: {}, lastChangeSeq: 0 };
  }
}

/** A scope entry for scoped sync — describes a loaded prefix and its load options. */
export interface ScopeEntry {
  prefix: string;
  limit?: number;
}

/** Result of a sync operation. */
export interface SyncResult {
  type: 'state:diff' | 'state:snapshot';
  changes?: Array<{ path: string; change: 'set' | 'delete'; value?: unknown; changeSeq: number }>;
  entries?: Record<string, unknown>;
  lastChangeSeq: number;
}

// Re-export for convenience — avoids circular imports between state/ and sessions/
import type { ConversationMessage } from '../sessions/types.ts';
export type { ConversationMessage };
