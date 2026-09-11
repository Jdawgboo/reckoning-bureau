import { StateBackend, type StateChangeEvent, type Unsubscribe } from './types.ts';
import type { ConversationMessage } from '../sessions/types.ts';

/**
 * In-memory StateBackend for unit tests and local dev without a server.
 * No persistence, no network. All data lives in Maps.
 */
export class InMemoryStateBackend extends StateBackend {
  /**
   * Serve `loadSession` from a snapshot, as production does.
   *
   * OFF by default, deliberately. Production loads snapshot + WAL tail; without
   * this the backend inherits the base defaults and every scenario replays the
   * full WAL — which is why the lab could not see the 2026-07-26 snapshot
   * regression. Turning it on globally re-grades a large number of existing
   * multi-turn expectations at once, because a later turn then opens on the
   * COLLAPSED history instead of the full one. Those need individual triage
   * ("was the old expectation right, or an artefact of full replay?"), so the
   * capability is opt-in and scenarios migrate one at a time.
   */
  #snapshotsEnabled: boolean;
  #data = new Map<string, unknown>();
  #seqs = new Map<string, number>(); // per-prefix sequence counters
  #listeners = new Set<(event: StateChangeEvent) => void>();
  #cacheResetListeners = new Set<() => void>();

  constructor(options?: { snapshots?: boolean }) {
    super();
    this.#snapshotsEnabled = options?.snapshots === true;
  }

  async get<T>(path: string): Promise<T | null> {
    return (this.#data.get(path) as T) ?? null;
  }

  async set<T>(path: string, value: T): Promise<void> {
    this.#data.set(path, value);
  }

  async delete(path: string): Promise<void> {
    // Delete this path and any children (subtree delete)
    this.#data.delete(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of [...this.#data.keys()]) {
      if (key.startsWith(prefix)) {
        this.#data.delete(key);
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#data.keys()].filter((k) => k.startsWith(prefix));
  }

  /**
   * Snapshot + WAL tail, mirroring `DirectStateBackend`.
   *
   * Implemented so the lab exercises the path production actually loads on.
   * Without it the base defaults apply — `loadSession` returns null and every
   * scenario replays the full WAL — which is why no lab test could see the
   * 2026-07-26 snapshot regression that dropped post-compaction messages.
   */
  override async writeSessionSnapshot(
    sessionId: string,
    messages: Record<string, unknown>[],
    coveredSeq?: number,
  ): Promise<{ snapshotSeq: number }> {
    const seq = coveredSeq ?? this.#seqs.get(`/sessions/${sessionId}/messages/`) ?? 0;
    this.#data.set(`/sessions/${sessionId}/snapshot`, { seq, messages });
    return { snapshotSeq: seq };
  }

  override async loadSession(
    sessionId: string,
  ): Promise<{ messages: ConversationMessage[]; snapshotSeq: number | null } | null> {
    if (!this.#snapshotsEnabled) return null;
    const snapshot = this.#data.get(`/sessions/${sessionId}/snapshot`);
    if (!snapshot || typeof snapshot !== 'object') return null;
    const { seq, messages } = snapshot as { seq: number; messages: ConversationMessage[] };

    const prefix = `/sessions/${sessionId}/messages/`;
    const tail = [...this.#data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .filter(([key]) => Number(key.slice(prefix.length)) > seq)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value as ConversationMessage);

    const now = new Date().toISOString();
    const wrapped: ConversationMessage[] = messages.map((msg) => {
      const record = msg as unknown as Record<string, unknown>;
      const role = record['role'];
      return {
        role:
          role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
            ? role
            : 'assistant',
        timestamp: now,
        data: msg,
      };
    });

    return { messages: [...wrapped, ...tail], snapshotSeq: seq };
  }

  async append(prefix: string, value: unknown): Promise<{ seq: number }> {
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const currentSeq = this.#seqs.get(normalizedPrefix) ?? 0;
    const nextSeq = currentSeq + 1;
    this.#seqs.set(normalizedPrefix, nextSeq);

    const paddedSeq = String(nextSeq).padStart(6, '0');
    this.#data.set(`${normalizedPrefix}${paddedSeq}`, value);

    return { seq: nextSeq };
  }

  /** Override for efficiency — direct Map access instead of get() per key. */
  override async load(
    prefix: string,
    options?: { limit?: number; depth?: number },
  ): Promise<{ entries: Record<string, unknown> }> {
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const allKeys = [...this.#data.keys()].filter((k) => k.startsWith(normalizedPrefix)).sort();

    let filteredKeys = allKeys;

    if (options?.depth != null) {
      const maxDepth = options.depth;
      filteredKeys = filteredKeys.filter((k) => {
        const relative = k.slice(normalizedPrefix.length);
        const segments = relative.split('/').filter(Boolean);
        return segments.length <= maxDepth;
      });
    }

    if (options?.limit != null && options.limit > 0 && filteredKeys.length > options.limit) {
      filteredKeys = filteredKeys.slice(-options.limit);
    }

    const entries: Record<string, unknown> = {};
    for (const key of filteredKeys) {
      entries[key] = this.#data.get(key);
    }
    return { entries };
  }

  /** Override: tracks listeners for simulateRemoteChange(). */
  override onRemoteChange(handler: (event: StateChangeEvent) => void): Unsubscribe {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  /** Override: tracks listeners for simulateCacheReset(). */
  override onCacheReset(handler: () => void): Unsubscribe {
    this.#cacheResetListeners.add(handler);
    return () => this.#cacheResetListeners.delete(handler);
  }

  /** Simulate a remote write (for testing). */
  simulateRemoteChange(event: StateChangeEvent): void {
    if (event.change === 'set') {
      this.#data.set(event.path, event.value);
    }
    if (event.change === 'delete') {
      this.#data.delete(event.path);
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[InMemoryStateBackend] Listener error:', err);
      }
    }
  }

  /** Simulate a full cache reset (for testing). */
  simulateCacheReset(): void {
    this.#data.clear();
    this.#seqs.clear();
    for (const handler of this.#cacheResetListeners) {
      handler();
    }
  }

  /** Get all state keys (for testing). */
  getAllKeys(): string[] {
    return [...this.#data.keys()];
  }
}
