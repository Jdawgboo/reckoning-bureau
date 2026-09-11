import { AgentSession } from './agent-session.ts';
import { log } from '../util/logger.ts';
import type { SessionManager, StateTree } from '../bl/agent/agent-library.ts';
import { hydrateSession } from './session-hydration.ts';
import {
  DEFAULT_MAX_SESSIONS,
  SessionCapacityError,
  assertMayJoinSession,
  selectEvictableSession,
} from './session-admission.ts';

export interface WsSessionManagerOptions {
  ttlMs?: number;
  /**
   * Callback invoked when a new session is created.
   * Use this to initialize external services (e.g., storage) for the session.
   */
  onSessionCreated?: (session: AgentSession) => Promise<void>;
  /** State tree's SessionManager — used to sync status from the authoritative source. */
  agentSessionManager?: SessionManager | null;
  /** State tree — used for subscribing to session status changes. */
  stateTree?: StateTree | null;
  /** Ceiling on live sessions. Defaults to {@link DEFAULT_MAX_SESSIONS}. */
  maxSessions?: number;
  /** Maps a formatting locale to the message bundle locale this build should use. */
  messageLocaleSelector?: (formatLocale: string) => string;
}

export interface SessionIdentity {
  userId: string;
  configId: string;
}

export interface WsSessionManagerStats {
  totalSessions: number;
  totalClients: number;
  idleSessions: number;
  processingSessions: number;
}

/**
 * Manages agent sessions with TTL-based expiry.
 *
 * When `agentSessionManager` and `stateTree` are provided, new sessions
 * automatically sync their status from the state tree and subscribe to
 * real-time status changes. This ensures triggers and background agent
 * runs are reflected in connected browser clients without ad-hoc checks.
 */
export class WsSessionManager {
  #sessions = new Map<string, AgentSession>();
  #ttlMs: number;
  #cleanupInterval: NodeJS.Timeout | null = null;
  #onSessionCreated: ((session: AgentSession) => Promise<void>) | null = null;
  #agentSessionManager: SessionManager | null;
  #stateTree: StateTree | null;
  /** In-flight creations keyed by sessionKey. `getOrCreate` awaits building
   *  and binding a session (never priming — see `#priming`), which is still
   *  async and opens a reentrancy window between the `#sessions` miss and
   *  the eventual `set()` — single-flighting here ensures concurrent
   *  `getOrCreate` calls for the same key await and receive the SAME
   *  AgentSession instead of each building and binding a separate one (the
   *  loser would leak its state-tree subscription and strand its client). */
  #creating = new Map<string, Promise<AgentSession>>();
  /** Background `hydrateSession` promises keyed by sessionKey, one per
   *  entry in `#sessions`. Priming (1-2 storage reads to warm a recreated
   *  session's A2UI surfaces/replay buffer) is fired-and-forgotten by
   *  `#createSession` so it never delays `getOrCreate`/connect — only stage
   *  resync and `content.query` need the warmed state, so they await
   *  `whenPrimed` instead. Entries are intentionally NOT removed once
   *  settled (a late caller must still get a resolved promise); they are
   *  deleted only alongside their `#sessions` counterpart. */
  #priming = new Map<string, Promise<void>>();
  #maxSessions: number;
  #messageLocaleSelector: ((formatLocale: string) => string) | undefined;

  constructor(options: WsSessionManagerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000; // 1 hour default
    this.#onSessionCreated = options.onSessionCreated ?? null;
    this.#agentSessionManager = options.agentSessionManager ?? null;
    this.#stateTree = options.stateTree ?? null;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#messageLocaleSelector = options.messageLocaleSelector;
  }

  /**
   * Get an existing session or create a new one.
   * Now async to support initialization callback.
   *
   * `sessionKey` is caller-supplied (`?agent_session_id=`), so every branch
   * that hands back a session someone else created runs the identity check
   * first — see `session-admission.ts` for why, and for the one case it cannot
   * separate.
   */
  async getOrCreate(sessionKey: string, identity: SessionIdentity): Promise<AgentSession> {
    const session = this.#sessions.get(sessionKey);

    if (session) {
      // Checked for the expired record too, not just the live one: the stored
      // conversation behind this id is about to be rehydrated into the
      // replacement session, so refusing only while the live object survives
      // would leave the same gap one TTL later.
      this.#assertMayAttach(sessionKey, session, identity);
    }

    if (session && !session.isExpired()) {
      session.touch();
      return session;
    }

    // Create new session (or replace expired one)
    if (session) {
      log('info', { event: 'session.expired', sessionKey });
      session.cleanup();
    }

    const inFlight = this.#creating.get(sessionKey);
    if (inFlight) {
      const pending = await inFlight;
      this.#assertMayAttach(sessionKey, pending, identity);
      return pending;
    }

    // Replacing an expired record reuses its slot, so only a genuinely new key
    // has to make room.
    if (!session) {
      this.#admitNewSession(sessionKey);
    }

    const creation = this.#createSession(sessionKey, identity).finally(() => {
      this.#creating.delete(sessionKey);
    });
    this.#creating.set(sessionKey, creation);
    return creation;
  }

  /** Refuses `identity` if `session` was created for someone else. */
  #assertMayAttach(sessionKey: string, session: AgentSession, identity: SessionIdentity): void {
    try {
      assertMayJoinSession({
        sessionKey,
        sessionUserId: session.userId,
        connectingUserId: identity.userId,
      });
    } catch (error) {
      log('warn', {
        event: 'session.attach.denied',
        sessionKey,
        sessionUserId: session.userId,
        connectingUserId: identity.userId,
      });
      throw error;
    }
  }

  /**
   * Makes room for one more session, or throws when it cannot.
   *
   * Expired sessions are reaped first because that is free. Beyond that an idle
   * session is evicted rather than the new connection refused: eviction costs
   * the evicted client a rehydration on its next connect, whereas refusal turns
   * a visitor away outright — and bulk-allocated ids become exactly the idle
   * sessions this prefers to drop. Refusal is what is left when every session is
   * actively in use.
   */
  #admitNewSession(sessionKey: string): void {
    if (this.#sessions.size < this.#maxSessions) {
      return;
    }

    this.cleanupExpired();
    if (this.#sessions.size < this.#maxSessions) {
      return;
    }

    const evictableKey = selectEvictableSession(
      [...this.#sessions.entries()].map(([key, session]) => ({
        sessionKey: key,
        clientCount: session.clientCount,
        status: session.status,
        remainingTtlMs: session.remainingTtlMs,
      })),
    );

    if (!evictableKey) {
      log('warn', {
        event: 'session.capacity.refused',
        sessionKey,
        totalSessions: this.#sessions.size,
        maxSessions: this.#maxSessions,
      });
      throw new SessionCapacityError(
        `Session limit reached (${this.#maxSessions}) and every session is in use`,
      );
    }

    log('warn', {
      event: 'session.capacity.evicted',
      sessionKey,
      evictedSessionKey: evictableKey,
      totalSessions: this.#sessions.size,
      maxSessions: this.#maxSessions,
    });
    this.delete(evictableKey);
  }

  /**
   * Builds, binds, stores, and announces a new session for `sessionKey`.
   * Extracted from `getOrCreate` so it can be single-flighted: without
   * single-flighting, two concurrent `getOrCreate` calls for the same key
   * would each build and bind a separate `AgentSession` — the loser leaking
   * its state-tree subscription and stranding its client.
   *
   * Priming (`hydrateSession`) is started here but NOT awaited — it used to
   * sit on this path and add 1-2 storage-read round trips to every connect.
   * It is tracked in `#priming` so `whenPrimed` can be awaited by the
   * callers that actually need warmed state (stage resync,
   * `content.query`). `hydrateSession` already swallows its own errors via
   * its `onError` callback; the `.catch` below only guards against
   * something unexpected escaping it, so the tracked promise always settles
   * and `whenPrimed` never hangs or rejects.
   */
  async #createSession(sessionKey: string, identity: SessionIdentity): Promise<AgentSession> {
    const session = new AgentSession({
      sessionKey,
      userId: identity.userId,
      configId: identity.configId,
      ttlMs: this.#ttlMs,
      messageLocaleSelector: this.#messageLocaleSelector,
    });

    // Bind state tree subscription for real-time status sync. Both nodes
    // pull their current value once on bind (see bindStateSummary /
    // bindStateUiState) — the subscription alone only fires on CHANGE.
    if (this.#stateTree) {
      const sessionNode = this.#stateTree.sessions.get(sessionKey);
      session.bindStateSummary(sessionNode.summary);
      session.bindStateUiState(sessionNode.uiState);
      await session.bindStatePresentationLocale(sessionNode.presentationLocale);
    }

    // Warm the recreated session from durable storage — a dev-server
    // restart drops in-memory A2UI surface state (and the replay buffer)
    // even though CONTENT#/conversation history for this sessionKey is
    // intact. Best-effort: a genuinely new sessionKey has nothing to load,
    // so this is a cheap no-op for the common case.
    if (this.#agentSessionManager) {
      const agentSessionManager = this.#agentSessionManager;
      this.#priming.set(
        sessionKey,
        hydrateSession(session, {
          loadContent: (sid) => agentSessionManager.loadContent(sid),
          onError: (error) =>
            log('warn', {
              event: 'session.recreate.prime.failed',
              sessionKey,
              error: error instanceof Error ? error.message : String(error),
            }),
        }).catch((error) => {
          log('warn', {
            event: 'session.recreate.prime.unexpected_error',
            sessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    this.#sessions.set(sessionKey, session);

    log('info', {
      event: 'session.created',
      sessionKey,
      userId: identity.userId,
      configId: identity.configId,
      totalSessions: this.#sessions.size,
    });

    // Call async initialization hook if provided
    if (this.#onSessionCreated) {
      try {
        await this.#onSessionCreated(session);
      } catch (error) {
        log('error', {
          event: 'session.created.hook.error',
          sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return session;
  }

  /**
   * Get an existing session (returns undefined if not found or expired)
   */
  get(sessionKey: string): AgentSession | undefined {
    const session = this.#sessions.get(sessionKey);
    if (session && session.isExpired()) {
      log('info', { event: 'session.expired', sessionKey, trigger: 'access' });
      session.cleanup();
      this.#sessions.delete(sessionKey);
      this.#priming.delete(sessionKey);
      return undefined;
    }
    return session;
  }

  /**
   * Resolves once `sessionKey`'s background priming
   * (`hydrateSession`) has settled. Resolves immediately for a
   * sessionKey with no tracked priming — either it never needed priming
   * (no `agentSessionManager` configured) or it isn't a known session.
   * Await this before reading state priming warms: stage resync
   * (`buildResyncFrames`) and `content.query`'s stored-content reads. Never
   * await it on the connect path — that reintroduces the regression this
   * method exists to avoid.
   */
  whenPrimed(sessionKey: string): Promise<void> {
    return this.#priming.get(sessionKey) ?? Promise.resolve();
  }

  /**
   * Delete a session
   */
  delete(sessionKey: string): boolean {
    const session = this.#sessions.get(sessionKey);
    if (session) {
      session.cleanup();
      this.#sessions.delete(sessionKey);
      this.#priming.delete(sessionKey);
      log('info', { event: 'session.deleted', sessionKey, totalSessions: this.#sessions.size });
      return true;
    }
    return false;
  }

  /**
   * Get the number of sessions
   */
  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  startCleanup(intervalMs: number = 60000): void {
    if (this.#cleanupInterval) {
      return;
    }

    this.#cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);

    log('info', { event: 'cleanup.started', intervalMs });
  }

  /**
   * Stop periodic cleanup
   */
  stopCleanup(): void {
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
      log('info', { event: 'cleanup.stopped' });
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpired(): number {
    let cleaned = 0;
    for (const [key, session] of this.#sessions) {
      if (session.isExpired()) {
        const ageMs = Date.now() - session.createdAt.getTime();
        log('info', {
          event: 'session.expired',
          sessionKey: key,
          trigger: 'cleanup',
          ageMs,
          contentBuffered: session.contentSeq,
        });
        session.cleanup();
        this.#sessions.delete(key);
        this.#priming.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log('info', {
        event: 'cleanup.complete',
        cleanedCount: cleaned,
        remaining: this.#sessions.size,
      });
    }

    return cleaned;
  }

  /**
   * Graceful shutdown - clean up all sessions
   */
  shutdown(): void {
    log('info', { event: 'session.manager.shutdown', totalSessions: this.#sessions.size });
    this.stopCleanup();
    for (const [, session] of this.#sessions) {
      session.cleanup();
    }
    this.#sessions.clear();
    this.#priming.clear();
    log('info', { event: 'session.manager.shutdown.complete' });
  }

  /**
   * Get the session key of the most recently active (current) session.
   * Returns null if no active sessions.
   */
  getCurrentSessionKey(): string | null {
    let bestKey: string | null = null;
    let bestRemainingTtl = -1;

    for (const [key, session] of this.#sessions) {
      if (!session.isExpired() && session.remainingTtlMs > bestRemainingTtl) {
        bestRemainingTtl = session.remainingTtlMs;
        bestKey = key;
      }
    }

    return bestKey;
  }

  /**
   * Get session statistics
   */
  getStats(): WsSessionManagerStats {
    let totalClients = 0;
    let idleSessions = 0;
    let processingSessions = 0;

    for (const session of this.#sessions.values()) {
      totalClients += session.clientCount;
      if (session.status === 'idle') {
        idleSessions++;
      }
      if (session.status === 'processing') {
        processingSessions++;
      }
    }

    return {
      totalSessions: this.#sessions.size,
      totalClients,
      idleSessions,
      processingSessions,
    };
  }
}
