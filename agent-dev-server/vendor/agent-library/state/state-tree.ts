/**
 * StateTree — reactive state tree with typed accessors.
 *
 * Primary state interface for the agent. Provides:
 * - Tree navigation: state.at('/sessions/abc/messages')
 * - Typed accessors: state.sessions.get('abc'), state.data.get('config')
 * - Glob subscriptions: state.subscribe('/inbox/**', handler)
 * - Automatic event routing from backend to tree nodes
 *
 * Owns all subscription tracking. Nodes delegate subscribe() here.
 */

import type { StateBackend, StateChangeEvent, Unsubscribe, ScopeEntry } from './types.ts';
import type { IStateNode } from './state-node-types.ts';
import { StateNodeImpl, type StateTreeRef } from './state-node.ts';
import { RpcStateBackend } from './rpc-state-backend.ts';
import { globMatch } from './glob-match.ts';
import { SessionsAccessor, DataAccessor } from './accessors.ts';
import { getAgentLogger } from '../types/logger.ts';

const logger = getAgentLogger();

interface Subscription {
  /** Node path this subscription is scoped to (or '/' for root-level). */
  nodePath: string;
  /** Glob pattern (root-level or relative to node), or null for node+descendants. */
  pattern: string | null;
  handler: (event: StateChangeEvent) => void;
}

export class StateTree {
  #root: StateNodeImpl;
  #backend: StateBackend;
  #subscriptions: Subscription[] = [];
  #remoteUnsubscribe: Unsubscribe | null = null;
  #cacheResetUnsubscribe: Unsubscribe | null = null;
  #scopedSyncPromise: Promise<void> | null = null;
  #sessions: SessionsAccessor;
  #data: DataAccessor;

  constructor(backend: StateBackend) {
    this.#backend = backend;
    const treeRef: StateTreeRef = {
      backend,
      fireEvent: (event) => this.#routeEvent(event),
      addNodeSubscription: (nodePath, pattern, handler) =>
        this.#addSubscription(nodePath, pattern, handler),
    };
    this.#root = new StateNodeImpl('/', treeRef);
    this.#sessions = new SessionsAccessor(this);
    this.#data = new DataAccessor(this);
  }

  /** The underlying backend (for advanced use / testing). */
  get backend(): StateBackend {
    return this.#backend;
  }

  // -- Typed accessors --

  /** Typed session access: state.sessions.get('id'), state.sessions.list() */
  get sessions(): SessionsAccessor {
    return this.#sessions;
  }

  /** Typed data access: state.data.get('key'), state.data.set('key', value) */
  get data(): DataAccessor {
    return this.#data;
  }

  // -- Tree navigation --

  /** Navigate to a node by path. Creates intermediate nodes lazily. */
  at<T = unknown>(path: string): IStateNode<T> {
    if (path === '/' || path === '') {
      return this.#root as unknown as IStateNode<T>;
    }
    return this.#root.at(path) as unknown as IStateNode<T>;
  }

  // -- Flat helpers (convenience for internal event pipeline code) --

  /** Read a value by path. Loads from backend if not cached. */
  async get<T>(path: string): Promise<T | null> {
    const node = this.at(path);
    if (!node.loaded) {
      await node.load();
    }
    return node.data as T | null;
  }

  /** Write a value at path. */
  async set<T>(path: string, value: T): Promise<void> {
    await this.at(path).set(value);
  }

  /** Delete a value at path. */
  async delete(path: string): Promise<void> {
    await this.at(path).delete();
  }

  /** List child paths under a prefix. */
  async list(prefix: string): Promise<string[]> {
    return this.#backend.list(prefix);
  }

  // -- Subscriptions --

  /**
   * Subscribe to changes matching a glob pattern from the root.
   * This is the primary subscription API for event processing.
   *
   * @example
   * state.subscribe('/inbox/triggers/**', (event) => { ... })
   * state.subscribe('/sessions/* /messages/**', (event) => { ... })
   */
  subscribe(pattern: string, handler: (event: StateChangeEvent) => void): Unsubscribe {
    return this.#addSubscription('/', pattern, handler);
  }

  /**
   * Dispatch a synthetic event to subscribers.
   * Used by InboxReconciler to re-process missed events on startup.
   */
  dispatchLocal(event: StateChangeEvent): void {
    this.#applyEventToNode(event);
    this.#fireSubscribers(event);
  }

  // -- Scoped sync --

  /**
   * Collect the hydration scope from the tree — all loaded node prefixes.
   * Used on reconnect to tell the server which subtrees to sync.
   */
  collectHydrationScope(): ScopeEntry[] {
    const scope: ScopeEntry[] = [];
    this.#collectScope(this.#root, scope);
    return scope;
  }

  #collectScope(node: StateNodeImpl, scope: ScopeEntry[]): void {
    if (!node.loaded) {
      // Not loaded — but still recurse into children (intermediate nodes may not be loaded)
      for (const [, child] of node.children) {
        this.#collectScope(child as StateNodeImpl, scope);
      }
      return;
    }

    // If loaded with limit, this is a collection — contribute as a single scope entry
    // (don't recurse into individual children, they're covered by the collection)
    if (node.loadOptions?.limit != null) {
      scope.push({ prefix: node.path, limit: node.loadOptions.limit });
      return;
    }

    // Recurse into children — they may provide more specific scope
    let hasLoadedDescendants = false;
    for (const [, child] of node.children) {
      const beforeLen = scope.length;
      this.#collectScope(child as StateNodeImpl, scope);
      if (scope.length > beforeLen) {
        hasLoadedDescendants = true;
      }
    }

    // If no descendants contributed scope, this node is a scope leaf
    if (!hasLoadedDescendants) {
      scope.push({ prefix: node.path });
    }
  }

  // -- Connection lifecycle --

  /** Connect to the backend and start receiving remote notifications. */
  async connect(): Promise<void> {
    // Register cache reset handler
    this.#cacheResetUnsubscribe = this.#backend.onCacheReset(() => {
      this.#resetTree(this.#root);
    });

    // Listen for remote changes from the backend (server pushes)
    this.#remoteUnsubscribe = this.#backend.onRemoteChange((event) => {
      this.#routeEvent(event);
    });

    // If backend supports scoped sync, intercept reconnect
    if (this.#backend instanceof RpcStateBackend) {
      this.#backend.setReconnectHandler(() => {
        this.#scopedSync();
      });
    }

    await this.#backend.connect();
  }

  /** Perform scoped sync on reconnect — sync only loaded prefixes. */
  async #scopedSync(): Promise<void> {
    if (!(this.#backend instanceof RpcStateBackend)) {
      return;
    }

    // Guard against concurrent syncs from rapid reconnects
    if (this.#scopedSyncPromise) {
      logger.debug('[StateTree] Scoped sync already in progress, skipping');
      return;
    }

    this.#scopedSyncPromise = this.#doScopedSync();
    try {
      await this.#scopedSyncPromise;
    } finally {
      this.#scopedSyncPromise = null;
    }
  }

  async #doScopedSync(): Promise<void> {
    if (!(this.#backend instanceof RpcStateBackend)) {
      return;
    }

    const scope = this.collectHydrationScope();
    logger.debug('[StateTree] Scoped sync on reconnect', {
      scopeEntries: scope.length,
      scope,
      lastChangeSeq: this.#backend.lastChangeSeq,
    });

    const result = await this.#backend.syncWithScope(this.#backend.lastChangeSeq, scope);

    if (result.type === 'state:snapshot') {
      // Reset loaded nodes, then apply snapshot entries
      this.#resetTree(this.#root);
      for (const [path, value] of Object.entries(result.entries ?? {})) {
        this.#applyEventToNode({
          path,
          change: 'set',
          value,
          source: 'remote',
          timestamp: new Date().toISOString(),
          changeSeq: result.lastChangeSeq,
        });
      }
      // Fire subscribers for all snapshot entries
      for (const [path, value] of Object.entries(result.entries ?? {})) {
        this.#fireSubscribers({
          path,
          change: 'set',
          value,
          source: 'remote',
          timestamp: new Date().toISOString(),
          changeSeq: result.lastChangeSeq,
        });
      }
    } else if (result.type === 'state:diff') {
      for (const change of result.changes ?? []) {
        this.#routeEvent({
          path: change.path,
          change: change.change,
          value: change.value,
          source: 'remote',
          timestamp: new Date().toISOString(),
          changeSeq: change.changeSeq,
        });
      }
    }
  }

  /** Disconnect from server. Tree nodes remain intact. */
  disconnect(): void {
    this.#cacheResetUnsubscribe?.();
    this.#cacheResetUnsubscribe = null;
    this.#remoteUnsubscribe?.();
    this.#remoteUnsubscribe = null;
    this.#backend.disconnect();
  }

  // -- Internal --

  #addSubscription(
    nodePath: string,
    pattern: string | null,
    handler: (event: StateChangeEvent) => void,
  ): Unsubscribe {
    const sub: Subscription = { nodePath, pattern, handler };
    this.#subscriptions.push(sub);
    return () => {
      const idx = this.#subscriptions.indexOf(sub);
      if (idx >= 0) {
        this.#subscriptions.splice(idx, 1);
      }
    };
  }

  /**
   * Route an event through the tree:
   * 1. Update the target node's data
   * 2. Fire all matching subscriptions
   */
  #routeEvent(event: StateChangeEvent): void {
    this.#applyEventToNode(event);
    this.#fireSubscribers(event);
  }

  /** Update the target node's data/loaded state from an event. */
  #applyEventToNode(event: StateChangeEvent): void {
    const node = this.#root.at(event.path);
    if (event.change === 'set') {
      node.data = event.value ?? null;
      node.loaded = true;
    } else if (event.change === 'delete') {
      node.data = null;
      node.loaded = false;
      // Clear child nodes so stale children don't remain in memory.
      // StateNodeImpl.clearChildren() handles the private Map.
      node.clearChildren();
    }
  }

  /** Fire all subscriptions that match the event. */
  #fireSubscribers(event: StateChangeEvent): void {
    for (const sub of [...this.#subscriptions]) {
      if (this.#subscriptionMatches(sub, event.path)) {
        try {
          sub.handler(event);
        } catch (err) {
          console.error(`[StateTree] Subscriber error (node=${sub.nodePath}):`, err);
        }
      }
    }
  }

  /** Check if a subscription matches an event path. */
  #subscriptionMatches(sub: Subscription, eventPath: string): boolean {
    if (sub.pattern !== null) {
      // Pattern subscription — build full glob from node path + relative pattern
      const fullPattern =
        sub.nodePath === '/' ? `/${sub.pattern}` : `${sub.nodePath}/${sub.pattern}`;
      return globMatch(eventPath, fullPattern);
    }

    // No pattern — matches this node and all descendants
    if (sub.nodePath === '/') {
      return true;
    }
    return eventPath === sub.nodePath || eventPath.startsWith(`${sub.nodePath}/`);
  }

  /** Recursively mark all nodes as unloaded (on cache reset). */
  #resetTree(node: StateNodeImpl): void {
    node.data = null;
    node.loaded = false;
    for (const [, child] of node.children) {
      this.#resetTree(child as StateNodeImpl);
    }
  }
}
