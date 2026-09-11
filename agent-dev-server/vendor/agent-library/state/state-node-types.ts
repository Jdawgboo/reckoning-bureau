/**
 * State tree types — StateNode interface and load options.
 *
 * StateNode is the core abstraction: every path in the state tree is a node
 * that carries both its data and its lifecycle (loaded, loading, etc.).
 */

import type { StateChangeEvent, Unsubscribe } from './types.ts';

/** Options for loading a node or subtree. */
export interface LoadOptions {
  /** For collections: load last N items. */
  limit?: number;
  /** How many levels deep to hydrate (default: single value for leaf nodes). */
  depth?: number;
  /** Reload even if already loaded. */
  force?: boolean;
}

/**
 * IStateNode — a node in the reactive state tree.
 *
 * Each node is both data and its own manager: it knows whether it's loaded,
 * can load itself, persists itself, and re-syncs itself on reconnect.
 */
export interface IStateNode<T = unknown> {
  /** Full path of this node (e.g., '/sessions/abc/summary'). */
  readonly path: string;
  /** The last segment of the path (e.g., 'summary'). */
  readonly name: string;
  /** The value at this node, or null if not loaded / deleted. */
  data: T | null;
  /** Whether this node has been hydrated from the backend. */
  readonly loaded: boolean;
  /** Whether a load is currently in progress. */
  readonly loading: boolean;

  /** Hydrate this node from the backend. */
  load(options?: LoadOptions): Promise<void>;
  /** Persist a value at this node. */
  set(value: T): Promise<void>;
  /** Remove this node from the backend. */
  delete(): Promise<void>;
  /** Append a value to this collection node. Returns the assigned seq number. */
  append(value: unknown): Promise<number>;

  /** Child nodes (populated after load). */
  readonly children: ReadonlyMap<string, IStateNode>;
  /** Navigate to a child node (creates lazily if needed). */
  at(relativePath: string): IStateNode;

  /** Subscribe to changes at this node and all descendants. */
  subscribe(handler: (event: StateChangeEvent) => void): Unsubscribe;
  /** Subscribe to changes matching a pattern relative to this node. */
  subscribe(pattern: string, handler: (event: StateChangeEvent) => void): Unsubscribe;
}

export type { StateChangeEvent, Unsubscribe };
