/**
 * StateNodeImpl — a node in the reactive state tree.
 *
 * Each path in the state tree is a StateNodeImpl. A node carries both its data
 * and its lifecycle: it knows whether it's loaded, can load itself, and persists itself.
 *
 * Nodes are pure data + navigation. All subscription tracking and event routing
 * lives in StateTree.
 *
 * Nodes are created lazily via at() — navigating to a path doesn't trigger any I/O.
 */

import type { StateBackend, StateChangeEvent, Unsubscribe } from './types.ts';
import type { IStateNode, LoadOptions } from './state-node-types.ts';

/** Internal reference to the root StateTree for event routing and subscriptions. */
export interface StateTreeRef {
  backend: StateBackend;
  fireEvent(event: StateChangeEvent): void;
  addNodeSubscription(
    nodePath: string,
    pattern: string | null,
    handler: (event: StateChangeEvent) => void,
  ): Unsubscribe;
}

export class StateNodeImpl implements IStateNode {
  readonly path: string;
  readonly name: string;
  #data: unknown | null = null;
  #loaded = false;
  #loading = false;
  #loadPromise: Promise<void> | null = null;
  #loadOptions?: LoadOptions;
  #children = new Map<string, StateNodeImpl>();
  #tree: StateTreeRef;

  constructor(path: string, tree: StateTreeRef) {
    this.path = path;
    // Extract name from path: '/sessions/abc/summary' → 'summary'
    const segments = path.split('/').filter(Boolean);
    this.name = segments.length > 0 ? segments[segments.length - 1] : '';
    this.#tree = tree;
  }

  get data(): unknown | null {
    return this.#data;
  }

  set data(value: unknown | null) {
    this.#data = value;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  set loaded(value: boolean) {
    this.#loaded = value;
  }

  get loading(): boolean {
    return this.#loading;
  }

  get loadOptions(): LoadOptions | undefined {
    return this.#loadOptions;
  }

  get children(): ReadonlyMap<string, IStateNode> {
    return this.#children as ReadonlyMap<string, IStateNode>;
  }

  /** Clear all child nodes (used by StateTree on remote delete). */
  clearChildren(): void {
    this.#children.clear();
  }

  /**
   * Navigate to a child node. Creates intermediate nodes lazily if needed.
   * Does NOT trigger any I/O — call load() to hydrate.
   */
  at(relativePath: string): StateNodeImpl {
    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      return this;
    }

    const segments = normalized.split('/');
    let current: StateNodeImpl = this;

    for (const segment of segments) {
      let child = current.#children.get(segment);
      if (!child) {
        const childPath = current.path === '/' ? `/${segment}` : `${current.path}/${segment}`;
        child = new StateNodeImpl(childPath, this.#tree);
        current.#children.set(segment, child);
      }
      current = child;
    }

    return current;
  }

  /**
   * Hydrate this node from the backend.
   *
   * - Without options: loads this node's value via backend.get() (single value).
   * - With depth or limit: loads subtree via backend.load() (batch).
   */
  async load(options?: LoadOptions): Promise<void> {
    if (this.#loading && this.#loadPromise) {
      // If options differ from the in-flight request, wait for it then reload
      if (
        options &&
        this.#loadOptions &&
        JSON.stringify(options) !== JSON.stringify(this.#loadOptions)
      ) {
        await this.#loadPromise;
        // Fall through to re-load with new options
      } else {
        return this.#loadPromise;
      }
    }
    if (this.#loaded && !options?.force) {
      return;
    }

    this.#loading = true;
    this.#loadPromise = this.#doLoad(options);
    try {
      await this.#loadPromise;
    } finally {
      this.#loading = false;
      this.#loadPromise = null;
    }
  }

  async #doLoad(options?: LoadOptions): Promise<void> {
    const backend = this.#tree.backend;
    this.#loadOptions = options;

    // Subtree load (depth or limit specified)
    if (options?.depth != null || options?.limit != null) {
      const prefix = this.path.endsWith('/') ? this.path : `${this.path}/`;

      const { entries } = await backend.load(prefix, {
        limit: options.limit,
        depth: options.depth,
      });

      // Populate children from entries
      for (const [entryPath, value] of Object.entries(entries)) {
        const child = this.at(entryPath.slice(this.path.length));
        child.#data = value;
        child.#loaded = true;
      }

      this.#loaded = true;
      return;
    }

    // Single value load (no options, or force-only)
    const value = await backend.get(this.path);
    this.#data = value;
    this.#loaded = true;
  }

  /** Persist a value at this node. Skips write if value is unchanged. */
  async set(value: unknown): Promise<void> {
    // Skip if value is identical to current data (avoid redundant writes and events)
    if (this.#loaded && this.#data !== null) {
      try {
        if (JSON.stringify(this.#data) === JSON.stringify(value)) {
          return;
        }
      } catch (_err) {
        // If serialization fails, proceed with the write
      }
    }

    await this.#tree.backend.set(this.path, value);
    this.#data = value;
    this.#loaded = true;
    this.#tree.fireEvent({
      path: this.path,
      change: 'set',
      value,
      source: 'local',
      timestamp: new Date().toISOString(),
    });
  }

  /** Remove this node from the backend. */
  async delete(): Promise<void> {
    await this.#tree.backend.delete(this.path);
    this.#data = null;
    this.#loaded = false;
    // Clear children
    this.#children.clear();
    this.#tree.fireEvent({
      path: this.path,
      change: 'delete',
      source: 'local',
      timestamp: new Date().toISOString(),
    });
  }

  /** Append a value to this collection node. Returns the assigned seq number. */
  async append(value: unknown): Promise<number> {
    const prefix = this.path.endsWith('/') ? this.path : `${this.path}/`;
    const result = await this.#tree.backend.append(prefix, value);

    // Defensive: if the backend returns a malformed response (e.g. an `{error}`
    // payload that wasn't promoted to a packet-level rejection), surface it as
    // a thrown error instead of silently caching the value under key
    // `String(undefined)` = 'undefined' — which sorts AFTER all numeric keys
    // and puts the entry at the wrong position on subsequent loads.
    const seq = (result as { seq?: unknown } | null | undefined)?.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      const err = (result as { error?: unknown } | null | undefined)?.error;
      throw new Error(
        `[StateNode] backend.append for "${prefix}" returned malformed response: ` +
          `seq=${String(seq)} ${err ? `error=${String(err)}` : ''}`.trim(),
      );
    }

    // Create child node with padded seq
    const paddedSeq = String(seq).padStart(6, '0');
    const child = this.at(paddedSeq);
    child.#data = value;
    child.#loaded = true;

    this.#tree.fireEvent({
      path: `${prefix}${paddedSeq}`,
      change: 'set',
      value,
      source: 'local',
      timestamp: new Date().toISOString(),
    });

    return seq;
  }

  /**
   * Subscribe to changes.
   * - subscribe(handler) — fires for this node and all descendants.
   * - subscribe(pattern, handler) — fires for changes matching the relative glob pattern.
   *
   * Delegates to StateTree which owns all subscription tracking.
   */
  subscribe(
    patternOrHandler: string | ((event: StateChangeEvent) => void),
    maybeHandler?: (event: StateChangeEvent) => void,
  ): Unsubscribe {
    if (typeof patternOrHandler === 'function') {
      return this.#tree.addNodeSubscription(this.path, null, patternOrHandler);
    }
    if (!maybeHandler) {
      throw new Error('subscribe(pattern, handler) requires a handler function');
    }
    return this.#tree.addNodeSubscription(this.path, patternOrHandler, maybeHandler);
  }
}
