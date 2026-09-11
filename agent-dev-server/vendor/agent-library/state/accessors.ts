/**
 * Typed domain accessors for the state tree.
 *
 * These provide ergonomic, type-safe access to known state domains:
 * - state.sessions.get('id') → SessionNode
 * - state.data.get('key') → typed value
 *
 * Under the hood, they delegate to state.at() — pure sugar.
 */

import type { IStateNode } from './state-node-types.ts';
import type {
  SessionSummary,
  ConversationMessage,
  ActivityEntry,
  PersistedContentItem,
  SessionPresentationLocale,
} from '../sessions/types.ts';
import type { ResolvedToolResults } from '../core/blocking.ts';

// Forward reference to StateTree to avoid circular imports.
// We only need at() and subscribe() from it.
interface StateTreeLike {
  at(path: string): IStateNode;
}

/**
 * Typed access to sessions: state.sessions.get('id'), state.sessions.list()
 */
export class SessionsAccessor {
  #tree: StateTreeLike;

  constructor(tree: StateTreeLike) {
    this.#tree = tree;
  }

  /** Get a typed session node by ID. Does NOT load — call .summary.load() etc. */
  get(sessionId: string): SessionNode {
    return new SessionNode(this.#tree.at(`/sessions/${sessionId}`));
  }

  /** Load and return all session summaries. */
  async list(): Promise<SessionSummary[]> {
    const sessionsNode = this.#tree.at('/sessions');
    await sessionsNode.load({ depth: 2 });
    const summaries: SessionSummary[] = [];
    for (const [, sessionNode] of sessionsNode.children) {
      const summaryNode = sessionNode.at('summary');
      if (summaryNode.loaded && summaryNode.data) {
        summaries.push(summaryNode.data as SessionSummary);
      }
    }
    return summaries;
  }
}

/**
 * A typed session node with named accessors for summary, messages, activity.
 */
export class SessionNode {
  #node: IStateNode;

  constructor(node: IStateNode) {
    this.#node = node;
  }

  /** The underlying state node. */
  get node(): IStateNode {
    return this.#node;
  }

  /** Session summary (metadata, status, message count). */
  get summary(): IStateNode<SessionSummary> {
    return this.#node.at('summary') as IStateNode<SessionSummary>;
  }

  /** Conversation messages (collection — use .load({ limit }) then .children). */
  get messages(): IStateNode<ConversationMessage> {
    return this.#node.at('messages') as IStateNode<ConversationMessage>;
  }

  /** Activity log entries (collection). */
  get activity(): IStateNode<ActivityEntry> {
    return this.#node.at('activity') as IStateNode<ActivityEntry>;
  }

  /** UI content items (collection — append-only, never compacted). */
  get content(): IStateNode<PersistedContentItem> {
    return this.#node.at('content') as IStateNode<PersistedContentItem>;
  }

  /**
   * Session UI state (single record — client-writable, agent-readable,
   * latest-wins). Carries A2UI data models and other per-session UI state; the
   * client mutates it via a `state.update` request and the agent reads it each
   * turn. Excluded from conversation history and compaction.
   */
  get uiState(): IStateNode<Record<string, unknown>> {
    return this.#node.at('uiState') as IStateNode<Record<string, unknown>>;
  }

  /** Durable desired presentation locale; active browser bundles remain connection-local. */
  get presentationLocale(): IStateNode<SessionPresentationLocale> {
    return this.#node.at('presentationLocale') as IStateNode<SessionPresentationLocale>;
  }

  /**
   * Compaction snapshot (single record — seq + compacted messages).
   * Schema is server-owned (SnapshotRecord in packages/server); agent-library
   * only names the path. Cast to SnapshotRecord at the server call site.
   */
  get snapshot(): IStateNode<Record<string, unknown>> {
    return this.#node.at('snapshot') as IStateNode<Record<string, unknown>>;
  }

  /** Accumulated blocking-tool resolutions (single record — toolCallId → output | null). */
  get resolvedToolResults(): IStateNode<ResolvedToolResults> {
    return this.#node.at('resolvedToolResults') as IStateNode<ResolvedToolResults>;
  }

  /** Delete this session and all its data (summary, messages, activity). */
  async delete(): Promise<void> {
    return this.#node.delete();
  }
}

/**
 * Typed access to the /data/ namespace: state.data.get('key'), state.data.set('key', value)
 */
export class DataAccessor {
  #tree: StateTreeLike;

  constructor(tree: StateTreeLike) {
    this.#tree = tree;
  }

  /** Load and return a value from /data/{key}. */
  async get<T>(key: string): Promise<T | null> {
    const node = this.#tree.at(`/data/${key}`);
    await node.load();
    return node.data as T | null;
  }

  /** Set a value at /data/{key}. */
  async set<T>(key: string, value: T): Promise<void> {
    return this.#tree.at(`/data/${key}`).set(value);
  }

  /** Delete a value at /data/{key}. */
  async delete(key: string): Promise<void> {
    return this.#tree.at(`/data/${key}`).delete();
  }
}
