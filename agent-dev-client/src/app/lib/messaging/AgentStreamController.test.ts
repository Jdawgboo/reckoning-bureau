import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AgentStreamController } from './AgentStreamController.ts';
import type { IStreamingStore } from '../../../../vendor/agent-library/ui/streaming-store.ts';
import type { IWebSocketManager } from '../services/websocket-manager.ts';

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

class FakeMessagingStore implements IStreamingStore {
  processMessageCalls: unknown[] = [];
  clearStreamingMessagesCalls: string[] = [];
  restoreCalls: Array<{ configId: string; items: unknown[] }> = [];

  processMessage(_configId: string, payload: unknown) {
    this.processMessageCalls.push(payload);
  }
  clearStreamingMessages(configId: string) {
    this.clearStreamingMessagesCalls.push(configId);
  }
  restore(configId: string, items: unknown[]) {
    this.restoreCalls.push({ configId, items });
  }
}

function makeFakeWs(overrides: Partial<IWebSocketManager> = {}): IWebSocketManager {
  return {
    queryContent: async (_afterSeq) => ({
      type: 'content.query.ack' as const,
      items: [],
      snapshot: null,
      snapshotEventSeq: null,
      streamStatus: 'complete' as const,
      activeRequestId: null,
    }),
    abortStream: async (_responseId) => ({ aborted: true }),
    getSessionInfo: async () => ({ status: 'idle' }),
    onReconnect: (_handler) => () => {},
    ...overrides,
  };
}

test('handleTerminal finish resolves pending request and resets session', async () => {
  const messaging = new FakeMessagingStore();
  const ctrl = new AgentStreamController(messaging, makeFakeWs(), { baseDelayMs: 0 });

  const p = ctrl.beginRequest();
  ctrl.trackStream('resp-1');

  const handled = ctrl.handleTerminal('finish', 'resp-1');
  assert.equal(handled, true);
  await p; // should resolve
  assert.equal(ctrl.state, 'idle');
});

test('handleTerminal error rejects pending request and resets session', async () => {
  const messaging = new FakeMessagingStore();
  const ctrl = new AgentStreamController(messaging, makeFakeWs(), { baseDelayMs: 0 });

  const p = ctrl.beginRequest();
  ctrl.trackStream('resp-1');

  const handled = ctrl.handleTerminal('error', 'resp-1', 'boom');
  assert.equal(handled, true);
  await assert.rejects(() => p, /boom/);
  assert.equal(ctrl.state, 'idle');
});

test('handleTerminal stale event (responseId mismatch) returns false', () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs());

  const p = ctrl.beginRequest();
  p.catch(() => {}); // prevent unhandled rejection when abort() is called
  ctrl.trackStream('resp-1');

  const handled = ctrl.handleTerminal('finish', 'resp-STALE');
  assert.equal(handled, false);
  // pending promise must still be alive — do not resolve/reject
  assert.equal(ctrl.hasPending, true);
  ctrl.abort();
});

test('handleTerminal pre-correlation event (no responseId yet) returns false', () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs());

  const p = ctrl.beginRequest();
  p.catch(() => {}); // prevent unhandled rejection when abort() is called
  // NOT calling trackStream yet — simulates event arriving before responseId is set

  const handled = ctrl.handleTerminal('finish', 'resp-early');
  assert.equal(handled, false);
  assert.equal(ctrl.hasPending, true);
  ctrl.abort();
});

test('handleTerminal with no responseId in event (no guard) resolves', async () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs(), {
    baseDelayMs: 0,
  });

  const p = ctrl.beginRequest();
  ctrl.trackStream(null); // welcome-message path: no responseId

  const handled = ctrl.handleTerminal('finish', undefined);
  assert.equal(handled, true);
  await p;
});

test('notifyDisconnected triggers session resume loop', async () => {
  let resumeCalls = 0;
  const messaging = new FakeMessagingStore();
  const ws = makeFakeWs({
    queryContent: async () => {
      resumeCalls++;
      return {
        type: 'content.query.ack' as const,
        items: [],
        snapshot: null,
        snapshotEventSeq: null,
        streamStatus: 'complete' as const,
        activeRequestId: null,
      };
    },
  });
  const ctrl = new AgentStreamController(messaging, ws, { baseDelayMs: 0 });

  const p = ctrl.beginRequest();
  ctrl.trackStream('resp-1');
  ctrl.notifyDisconnected();

  assert.equal(ctrl.state, 'paused');
  await tick();
  assert.ok(resumeCalls >= 1, 'onResume should fire');
  assert.equal(ctrl.state, 'idle');
  await p; // should resolve (stream complete)
});

test('resolvePendingIfActive returns false when nothing pending', () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs());
  assert.equal(ctrl.resolvePendingIfActive(), false);
});

test('resolvePendingIfActive resolves pending and returns true', async () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs(), {
    baseDelayMs: 0,
  });
  const p = ctrl.beginRequest();
  ctrl.trackStreamOnly(); // initializeSession path: no responseId
  const resolved = ctrl.resolvePendingIfActive();
  assert.equal(resolved, true);
  await p;
});

test('abort cancels pending request with CanceledError', async () => {
  const ctrl = new AgentStreamController(new FakeMessagingStore(), makeFakeWs());
  const p = ctrl.beginRequest();
  ctrl.trackStream('resp-1');
  ctrl.abort();
  await assert.rejects(
    () => p,
    (err: Error) => err.name === 'CanceledError',
  );
  assert.equal(ctrl.state, 'idle');
});

/**
 * Faithful model: restore wholesale-replaces the message list (real
 * AgentConversation.restore → setState({ messages })); processMessage upserts.
 */
class FaithfulStore implements IStreamingStore {
  messages: Array<{ messageId?: string }> = [];
  processMessage(_configId: string, payload: { messageId?: string }) {
    const idx = this.messages.findIndex((m) => m.messageId === payload.messageId);
    if (idx >= 0) this.messages[idx] = payload;
    else this.messages.push(payload);
  }
  clearStreamingMessages(_configId: string) {}
  restore(_configId: string, items: Array<{ messageId?: string }>) {
    this.messages = [...items];
  }
}

test('VERIFY deployed: second resume clobbers prior history (same root cause as builder)', async () => {
  const messaging = new FaithfulStore();
  const server = [
    { seq: 1, timestamp: 0, content: { type: 'TXT' as const, messageId: 'h1', content: 'a' } },
    { seq: 2, timestamp: 0, content: { type: 'TXT' as const, messageId: 'h2', content: 'b' } },
    { seq: 3, timestamp: 0, content: { type: 'TXT' as const, messageId: 'h3', content: 'c' } },
  ];
  const ws = makeFakeWs({
    queryContent: async (afterSeq) => ({
      type: 'content.query.ack' as const,
      items: server.filter((i) => i.seq > afterSeq),
      snapshot: null,
      snapshotEventSeq: null,
      streamStatus: 'complete' as const,
      activeRequestId: null,
    }),
  });
  const ctrl = new AgentStreamController(messaging, ws, { baseDelayMs: 0 });

  const p1 = ctrl.beginRequest();
  ctrl.trackStream('resp-1');
  ctrl.notifyDisconnected();
  await tick();
  await p1;
  assert.deepEqual(
    messaging.messages.map((m) => m.messageId),
    ['h1', 'h2', 'h3'],
    'first resume restores full history',
  );

  // A later turn streams seq 4,5 live (onContent → processMessage), then disconnects.
  server.push({
    seq: 4,
    timestamp: 0,
    content: { type: 'TXT' as const, messageId: 'h4', content: 'd' },
  });
  server.push({
    seq: 5,
    timestamp: 0,
    content: { type: 'TXT' as const, messageId: 'h5', content: 'e' },
  });
  messaging.processMessage('agent', { messageId: 'h4' });
  messaging.processMessage('agent', { messageId: 'h5' });

  const p2 = ctrl.beginRequest();
  ctrl.trackStream('resp-2');
  ctrl.notifyDisconnected();
  await tick();
  await p2;

  const ids = messaging.messages.map((m) => m.messageId);
  assert.ok(ids.includes('h1'), `expected h1 preserved after 2nd resume, got [${ids.join(', ')}]`);
});

test('resume restores content to messaging store', async () => {
  const messaging = new FakeMessagingStore();
  const ws = makeFakeWs({
    queryContent: async () => ({
      type: 'content.query.ack' as const,
      items: [
        {
          seq: 1,
          timestamp: Date.now(),
          content: { type: 'TXT' as const, messageId: 'm1', content: 'hello' },
        },
      ],
      snapshot: null,
      snapshotEventSeq: null,
      streamStatus: 'complete' as const,
      activeRequestId: null,
    }),
  });
  const ctrl = new AgentStreamController(messaging, ws, { baseDelayMs: 0 });

  const p = ctrl.beginRequest();
  ctrl.trackStream('resp-1');
  ctrl.notifyDisconnected();

  await tick();
  assert.ok(messaging.restoreCalls.length > 0, 'restore should be called');
  assert.equal(messaging.restoreCalls[0].configId, 'agent');
  await p;
});
