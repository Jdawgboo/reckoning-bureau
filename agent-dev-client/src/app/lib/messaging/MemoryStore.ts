import { makeAutoObservable } from 'mobx';
import type { MemoryEntry } from '@/app/lib/services/websocket-client.types';

const MEMORY_STORAGE_KEY_PREFIX = 'agentplace_memory_bank';
const MAX_MEMORY_ITEMS = 15;

/** Normalizes a summary for duplicate comparison: trim, collapse whitespace, lowercase. */
function normalizeSummary(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class MemoryStore {
  memories: MemoryEntry[] = [];
  initialized: boolean = false;

  private agentId: string | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  private getStorageKey(): string {
    if (!this.agentId) {
      throw new Error('MemoryStore not initialized');
    }
    return `${MEMORY_STORAGE_KEY_PREFIX}_${this.agentId}`;
  }

  get count(): number {
    return this.memories.length;
  }

  get isEmpty(): boolean {
    return this.memories.length === 0;
  }

  /**
   * Initialize the memory store with an agent-specific ID.
   * Must be called after agentId is known (e.g., after settings load).
   */
  initialize(agentId: string) {
    this.agentId = agentId;
    this.loadFromStorage();
    this.initialized = true;
    console.log(`[MemoryStore] Initialized for agent: ${agentId}`);
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(this.getStorageKey());
      if (stored) {
        this.memories = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load memories from storage:', error);
      this.memories = [];
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(this.memories));
    } catch (error) {
      console.error('Failed to save memories to storage:', error);
    }
  }

  /**
   * Appends a new memory, or — if a near-duplicate already exists (same
   * text once trimmed, whitespace-collapsed, and lowercased) — refreshes
   * that entry's `timestamp` instead of appending. Keeps the 15-slot budget
   * honest against retried tool calls and a repetitive model. `now` is
   * injectable for deterministic tests.
   */
  add(summary: string, now: number = Date.now()) {
    const normalized = normalizeSummary(summary);
    const duplicate = this.memories.find((m) => normalizeSummary(m.summary) === normalized);
    if (duplicate) {
      duplicate.timestamp = now;
    } else {
      const newMemory: MemoryEntry = {
        id: crypto.randomUUID(),
        summary,
        timestamp: now,
      };
      this.memories = [...this.memories, newMemory].slice(-MAX_MEMORY_ITEMS);
    }
    this.saveToStorage();
    console.info('[MemoryStore] saved', { count: this.memories.length });
  }

  remove(id: string) {
    this.memories = this.memories.filter((m) => m.id !== id);
    this.saveToStorage();
  }

  clear() {
    this.memories = [];
    this.saveToStorage();
  }

  /**
   * Returns the most recent memories, sorted by timestamp (oldest first),
   * limited to MAX_MEMORY_ITEMS.
   * Returns empty array if store is not initialized.
   */
  getAll(): MemoryEntry[] {
    if (!this.initialized) {
      console.warn('[MemoryStore] getAll() called before initialization');
      return [];
    }
    return [...this.memories].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_MEMORY_ITEMS);
  }

  getById(id: string): MemoryEntry | undefined {
    return this.memories.find((m) => m.id === id);
  }
}
