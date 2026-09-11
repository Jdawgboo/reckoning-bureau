import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentSession } from './agent-session.ts';
import type { IStateNode, SessionSummary } from '../bl/agent/agent-library.ts';

/** Minimal fake `IStateNode<SessionSummary>` — only `data`/`loaded`/`load`/
 *  `subscribe` are exercised by `bindStateSummary`. */
function createFakeSummaryNode(initialData: SessionSummary | null): IStateNode<SessionSummary> & {
  data: SessionSummary | null;
} {
  const node = {
    path: '/sessions/test/summary',
    name: 'summary',
    data: initialData,
    loaded: initialData !== null,
    loading: false,
    async load() {
      node.loaded = true;
    },
    async set(value: SessionSummary) {
      node.data = value;
    },
    async delete() {
      node.data = null;
    },
    async append() {
      return 0;
    },
    children: new Map(),
    at() {
      throw new Error('not implemented');
    },
    subscribe() {
      return () => {};
    },
  };
  return node;
}

function createSession(): AgentSession {
  return new AgentSession({
    sessionKey: 'sess-status-test',
    userId: 'user-1',
    configId: 'config-1',
    ttlMs: 60_000,
  });
}

/** Flushes the microtask queue so `bindStateSummary`'s fire-and-forget
 *  `.load().then(...)` chain settles before assertions run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentSession — bindStateSummary initial pull', () => {
  it('pulls a processing status on bind, but the getter self-heals it without a local run', async () => {
    const session = createSession();
    assert.strictEqual(session.status, 'idle');

    const summaryNode = createFakeSummaryNode({
      sessionId: 'sess-status-test',
      type: 'web',
      status: 'processing',
      messageCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
    session.bindStateSummary(summaryNode);
    await flush();

    assert.strictEqual(session.status, 'idle');
  });

  it('keeps a bound processing status when a local run is genuinely attached', async () => {
    const session = createSession();
    session.setStatus('processing');

    const summaryNode = createFakeSummaryNode({
      sessionId: 'sess-status-test',
      type: 'web',
      status: 'processing',
      messageCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
    session.bindStateSummary(summaryNode);
    await flush();

    assert.strictEqual(session.status, 'processing');
  });

  it('leaves status idle when the summary has no data yet', async () => {
    const session = createSession();
    session.bindStateSummary(createFakeSummaryNode(null));
    await flush();
    assert.strictEqual(session.status, 'idle');
  });

  it('leaves status idle when the summary already reports idle', async () => {
    const session = createSession();
    session.bindStateSummary(
      createFakeSummaryNode({
        sessionId: 'sess-status-test',
        type: 'web',
        status: 'idle',
        messageCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await flush();
    assert.strictEqual(session.status, 'idle');
  });
});

describe('AgentSession — status getter self-heals a stale processing value', () => {
  it('reads idle for a stale processing value with no local run, and stays healed on a second read', async () => {
    const session = createSession();
    session.bindStateSummary(
      createFakeSummaryNode({
        sessionId: 'sess-status-test',
        type: 'web',
        status: 'processing',
        messageCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await flush();

    assert.strictEqual(session.status, 'idle');
    assert.strictEqual(session.status, 'idle');
  });

  it('keeps reporting processing for a genuine local run', async () => {
    const session = createSession();
    session.setStatus('processing');

    assert.strictEqual(session.status, 'processing');
    assert.strictEqual(session.status, 'processing');
  });
});

describe('AgentSession — getInfo self-heals a stale processing status', () => {
  it('reports idle and self-heals when status is processing but no local run is attached', async () => {
    const session = createSession();
    session.bindStateSummary(
      createFakeSummaryNode({
        sessionId: 'sess-status-test',
        type: 'web',
        status: 'processing',
        messageCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await flush();
    assert.strictEqual(session.status, 'idle');

    const info = await session.getInfo();
    assert.strictEqual(info.status, 'idle');
    assert.strictEqual(session.status, 'idle');
  });

  it('reports processing when a local run is genuinely attached (setStatus was called)', async () => {
    const session = createSession();
    session.setStatus('processing');

    const info = await session.getInfo();
    assert.strictEqual(info.status, 'processing');
    assert.strictEqual(session.status, 'processing');
  });

  it('reports idle unchanged when already idle', async () => {
    const session = createSession();
    const info = await session.getInfo();
    assert.strictEqual(info.status, 'idle');
  });

  it('a run that finished (setStatus idle) is not reported as processing afterwards', async () => {
    const session = createSession();
    session.setStatus('processing');
    session.setStatus('idle');

    const info = await session.getInfo();
    assert.strictEqual(info.status, 'idle');
  });
});
