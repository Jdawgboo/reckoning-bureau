import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WsSessionManager } from './session-manager.ts';
import { SessionAccessDeniedError, SessionCapacityError } from './session-admission.ts';
import { SessionManager, StateTree, InMemoryStateBackend } from '../bl/agent/agent-library.ts';

/** Rejects with `message` after `ms` if `promise` hasn't settled — turns a
 *  reintroduced "getOrCreate awaits priming" regression into a fast, clear
 *  test failure instead of hanging until the runner's own timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** An `InMemoryStateBackend` whose `load()` blocks on an externally-held gate
 *  before delegating — used to simulate a slow `hydrateSession` read
 *  without constructing a real storage layer. */
class GatedStateBackend extends InMemoryStateBackend {
  #gate: Promise<void>;

  constructor(gate: Promise<void>) {
    super();
    this.#gate = gate;
  }

  override async load(
    prefix: string,
    options?: { limit?: number; depth?: number },
  ): Promise<{ entries: Record<string, unknown> }> {
    await this.#gate;
    return super.load(prefix, options);
  }
}

describe('WsSessionManager.getOrCreate — priming stays off the connect path', () => {
  it('resolves before a slow prime settles, in a deterministic order', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const state = new StateTree(new GatedStateBackend(gate));
    const agentSessionManager = new SessionManager(state);
    const manager = new WsSessionManager({ agentSessionManager });
    const identity = { userId: 'user-1', configId: 'config-1' };
    const order: string[] = [];

    await withTimeout(
      manager.getOrCreate('sess-slow-prime', identity),
      1000,
      'getOrCreate must not await priming',
    );
    order.push('getOrCreate');

    const whenPrimedDone = manager.whenPrimed('sess-slow-prime').then(() => {
      order.push('primed');
    });

    releaseGate();
    await withTimeout(whenPrimedDone, 1000, 'whenPrimed never settled after the gate opened');

    assert.deepStrictEqual(order, ['getOrCreate', 'primed']);
  });

  it('whenPrimed resolves immediately for a sessionKey with no tracked priming', async () => {
    const manager = new WsSessionManager();
    await withTimeout(
      manager.whenPrimed('never-primed'),
      1000,
      'whenPrimed(unknown key) must resolve immediately',
    );
  });
});

describe('WsSessionManager.getOrCreate — single-flight', () => {
  it('two concurrent calls for the same key resolve to the SAME session, created once', async () => {
    const manager = new WsSessionManager();
    const identity = { userId: 'user-1', configId: 'config-1' };

    const [first, second] = await Promise.all([
      manager.getOrCreate('sess-race', identity),
      manager.getOrCreate('sess-race', identity),
    ]);

    assert.ok(Object.is(first, second));
    assert.strictEqual(manager.size, 1);
  });

  it('a later call after creation settles still returns the same session', async () => {
    const manager = new WsSessionManager();
    const identity = { userId: 'user-1', configId: 'config-1' };

    const [first] = await Promise.all([
      manager.getOrCreate('sess-race-2', identity),
      manager.getOrCreate('sess-race-2', identity),
    ]);
    const third = await manager.getOrCreate('sess-race-2', identity);

    assert.ok(Object.is(first, third));
    assert.strictEqual(manager.size, 1);
  });
});

describe('WsSessionManager.getOrCreate — presentation locale hydration', () => {
  it('rehydrates durable locale before returning the recreated session', async () => {
    const state = new StateTree(new InMemoryStateBackend());
    await state.sessions.get('session-locale-restart').presentationLocale.set({
      messageLocale: 'fr',
      formatLocale: 'fr-CA',
      source: 'explicit',
      revision: 4,
    });
    const manager = new WsSessionManager({ stateTree: state });
    const recreated = await manager.getOrCreate('session-locale-restart', {
      userId: 'user-1',
      configId: 'config-1',
    });
    assert.deepStrictEqual(recreated.presentationLocale, {
      messageLocale: 'fr',
      formatLocale: 'fr-CA',
      source: 'explicit',
      revision: 4,
    });
  });
});

/**
 * These cover the WIRING, not the rules. `session-admission.test.ts` proves the
 * rules decide correctly; what can silently regress in a refactor is
 * `getOrCreate` forgetting to consult them on one of its four exit paths (live,
 * expired, in-flight, fresh).
 */
describe('WsSessionManager.getOrCreate — identity binding', () => {
  const ALICE = { userId: 'alice@example.com', configId: 'config-1' };
  const MALLORY = { userId: 'mallory@example.com', configId: 'config-1' };

  it('hands a live session back to the identity that created it', async () => {
    const manager = new WsSessionManager();
    const created = await manager.getOrCreate('sess-own', ALICE);
    const resumed = await manager.getOrCreate('sess-own', ALICE);

    assert.ok(Object.is(created, resumed));
  });

  it('refuses a live session to a different identity holding the key', async () => {
    const manager = new WsSessionManager();
    await manager.getOrCreate('sess-leaked', ALICE);

    await assert.rejects(
      () => manager.getOrCreate('sess-leaked', MALLORY),
      SessionAccessDeniedError,
    );
  });

  // Checking only live sessions would leave a gap: the expired session object is
  // replaced, and `session-hydration.ts` then loads the stored conversation into
  // whatever replaces it. Runtimes restart, so expiry is routine.
  it('refuses an EXPIRED session to a different identity', async () => {
    const manager = new WsSessionManager({ ttlMs: 1 });
    await manager.getOrCreate('sess-expired', ALICE);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      () => manager.getOrCreate('sess-expired', MALLORY),
      SessionAccessDeniedError,
    );
  });

  it('lets the owner reclaim their own expired session', async () => {
    const manager = new WsSessionManager({ ttlMs: 1 });
    await manager.getOrCreate('sess-expired-own', ALICE);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const replacement = await manager.getOrCreate('sess-expired-own', ALICE);
    assert.strictEqual(replacement.userId, ALICE.userId);
  });

  // The single-flight path returns a promise created for someone else, so it
  // needs its own check — the `#sessions` lookup above has not populated yet.
  it('refuses a different identity racing an in-flight creation', async () => {
    const manager = new WsSessionManager();
    const [, refused] = await Promise.allSettled([
      manager.getOrCreate('sess-inflight', ALICE),
      manager.getOrCreate('sess-inflight', MALLORY),
    ]);

    assert.strictEqual(refused.status, 'rejected');
    assert.ok(refused.reason instanceof SessionAccessDeniedError);
  });

  // `container.ts` attaches as 'cron'/'trigger' purely to broadcast a fired
  // schedule's output into whatever session is connected. It ignores errors from
  // that path, so a refusal here would stop schedules appearing, silently.
  it('lets a scheduled run attach to a user’s session to broadcast', async () => {
    const manager = new WsSessionManager();
    const created = await manager.getOrCreate('sess-scheduled', ALICE);

    const forCron = await manager.getOrCreate('sess-scheduled', {
      userId: 'cron',
      configId: 'config-1',
    });

    assert.ok(Object.is(created, forCron));
    assert.strictEqual(forCron.userId, ALICE.userId, 'the session keeps its original owner');
  });

  it('lets a user open a session a schedule created', async () => {
    const manager = new WsSessionManager();
    const created = await manager.getOrCreate('sess-from-cron', {
      userId: 'cron',
      configId: 'config-1',
    });

    assert.ok(Object.is(created, await manager.getOrCreate('sess-from-cron', ALICE)));
  });

  it('leaves the original session intact after a refusal', async () => {
    const manager = new WsSessionManager();
    const created = await manager.getOrCreate('sess-intact', ALICE);
    await assert.rejects(() => manager.getOrCreate('sess-intact', MALLORY));

    assert.ok(Object.is(created, await manager.getOrCreate('sess-intact', ALICE)));
    assert.strictEqual(manager.size, 1);
  });
});

describe('WsSessionManager.getOrCreate — allocation cap (allocation cap)', () => {
  const identity = { userId: 'user-1', configId: 'config-1' };

  it('evicts an idle session instead of growing past the cap', async () => {
    const manager = new WsSessionManager({ maxSessions: 2 });
    await manager.getOrCreate('sess-a', identity);
    await manager.getOrCreate('sess-b', identity);
    await manager.getOrCreate('sess-c', identity);

    assert.strictEqual(manager.size, 2);
    assert.strictEqual(manager.get('sess-a'), undefined);
    assert.ok(manager.get('sess-c'));
  });

  it('refuses a new session when every slot is actively connected', async () => {
    const manager = new WsSessionManager({ maxSessions: 1 });
    const held = await manager.getOrCreate('sess-held', identity);
    held.addClient('conn-1', { connectionId: 'conn-1' } as never);

    await assert.rejects(() => manager.getOrCreate('sess-new', identity), SessionCapacityError);
    assert.ok(Object.is(manager.get('sess-held'), held));
  });

  // Resuming must never be capacity-gated: the session already occupies its slot.
  it('resumes an existing session while at the cap', async () => {
    const manager = new WsSessionManager({ maxSessions: 1 });
    const created = await manager.getOrCreate('sess-only', identity);
    created.addClient('conn-1', { connectionId: 'conn-1' } as never);

    assert.ok(Object.is(await manager.getOrCreate('sess-only', identity), created));
  });

  it('reaps expired sessions before evicting a live one', async () => {
    const manager = new WsSessionManager({ maxSessions: 2, ttlMs: 1 });
    await manager.getOrCreate('sess-old-1', identity);
    await manager.getOrCreate('sess-old-2', identity);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await manager.getOrCreate('sess-fresh', identity);
    assert.strictEqual(manager.size, 1);
    assert.ok(manager.get('sess-fresh'));
  });
});
