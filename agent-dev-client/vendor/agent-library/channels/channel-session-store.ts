/**
 * Generic session store for channel integrations.
 *
 * Maps a context identifier (chat ID, channel ID, etc.) to a generation
 * counter. The session key is `{prefix}_{contextId}_{generation}`.
 * `/new` or `/reset` rotates the generation → fresh conversation.
 *
 * Persistence: the agent state tree under a caller-chosen path
 * (e.g. `/data/bots/discord`). The state tree is durable across server
 * restarts AND redeployments.
 *
 * API shape — sync constructor, async methods:
 *   const store = createChannelSessionStore(state, { ... });    // sync, no await
 *   const key = await store.getSessionKey(contextId);           // await each call
 *
 * The constructor kicks off hydration in the background. Each method awaits
 * hydration internally before lookup, so callers never see stale (gen=1)
 * keys for contexts that were rotated in a previous run. Forgetting `await`
 * on a method call yields a `Promise<string>` (caught by TypeScript and
 * visibly broken at runtime), not a cryptic "is not a function" error.
 *
 * SessionKey format: `{prefix}_{contextId}_{generation}`. The key is a session
 * id, so it must satisfy the contract in `sessions/session-id.ts` — in
 * particular no `/`, which would open an extra state-path segment and silently
 * break conversation-history persistence. (`:` used to be rejected too and is
 * why this format uses `_`; AGE-472 legalised `:` for role sessions, but `_`
 * stays the format here.)
 */

/**
 * Minimal subset of `StateTree` we depend on — kept local so this file
 * stays importable from the browser vendor (the full StateTree class is
 * server-only). The platform's StateTree class structurally satisfies this
 * interface, so callers pass it directly.
 */
export interface StateTreeLike {
  get<T>(path: string): Promise<T | undefined>;
  set(path: string, value: unknown): Promise<void>;
}

// ─── Public interfaces ────────────────────────────────────────────────

export interface ChannelSessionStore {
  /** Get the current sessionKey for a context — creates one at generation=1 if new. */
  getSessionKey(contextId: string): Promise<string>;
  /** Rotate to a new generation, returning the old and new sessionKeys. */
  rotate(contextId: string): Promise<{ oldSessionKey: string; newSessionKey: string }>;
}

export interface ChannelSessionStoreOptions {
  /** Session key prefix (e.g. 'dc', 'tg', 'sl'). */
  prefix: string;
  /**
   * State tree path for persistence (e.g. '/data/bots/discord').
   * MUST start with `/data/` — the platform state service only allows
   * paths under `/data/`, `/sessions/`, `/inbox/`, `/outbox/`.
   */
  statePath: string;
  /** Platform name for log messages (e.g. 'Discord', 'Telegram'). */
  platform: string;
}

// ─── Factory ──────────────────────────────────────────────────────────

/**
 * Create a session store for a channel integration.
 *
 * Synchronous — call without `await`. Hydration from the state tree starts
 * in the background; `getSessionKey` and `rotate` await it internally before
 * each lookup.
 *
 * @param stateTree  Agent state tree for durable persistence (null = in-memory only).
 * @param options    Platform-specific configuration.
 */
export function createChannelSessionStore(
  stateTree: StateTreeLike | null,
  options: ChannelSessionStoreOptions,
): ChannelSessionStore {
  const { prefix, statePath, platform } = options;
  const map = new Map<string, number>();

  // ── Boot: hydrate from state tree (background) ──
  // Started eagerly so the first message after boot finds the map populated.
  // Each public method awaits this before its lookup, eliminating the
  // pre-hydration race that returned gen=1 for contexts already at gen=N.
  const hydrationPromise: Promise<void> = stateTree
    ? (async () => {
        try {
          const existing = (await stateTree.get<Record<string, number>>(statePath)) ?? null;
          if (existing && typeof existing === 'object') {
            for (const [k, v] of Object.entries(existing)) {
              const gen = Number(v);
              if (Number.isFinite(gen) && gen > 0) {
                map.set(k, gen);
              }
            }
            console.log(
              `[${platform}] Loaded ${map.size} context session(s) from state tree (${statePath})`,
            );
          }
        } catch (err) {
          console.warn(`[${platform}] State tree read failed on boot (non-fatal):`, err);
        }
      })()
    : Promise.resolve();

  // ── Helpers ──

  async function persist(): Promise<void> {
    if (!stateTree) {
      return;
    }
    try {
      const sessions: Record<string, number> = {};
      for (const [k, v] of map) {
        sessions[k] = v;
      }
      await stateTree.set(statePath, sessions);
    } catch (err) {
      console.warn(`[${platform}] Failed to persist session store to state tree:`, err);
    }
  }

  function keyFor(contextId: string, gen: number): string {
    const safeContext = contextId.replaceAll(':', '_');
    return `${prefix}_${safeContext}_${gen}`;
  }

  // ── Store ──

  return {
    async getSessionKey(contextId: string): Promise<string> {
      await hydrationPromise;
      let gen = map.get(contextId);
      if (!gen) {
        gen = 1;
        map.set(contextId, gen);
        void persist();
      }
      return keyFor(contextId, gen);
    },

    async rotate(contextId: string): Promise<{ oldSessionKey: string; newSessionKey: string }> {
      await hydrationPromise;
      const currentGen = map.get(contextId) ?? 0;
      const oldSessionKey = currentGen > 0 ? keyFor(contextId, currentGen) : keyFor(contextId, 1);
      const newGen = currentGen + 1;
      map.set(contextId, newGen);
      void persist();
      return { oldSessionKey, newSessionKey: keyFor(contextId, newGen) };
    },
  };
}
