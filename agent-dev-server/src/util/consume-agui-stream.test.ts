import { describe, it } from 'node:test';
import assert from 'node:assert';
import { consumeAguiStream } from './consume-agui-stream.ts';
import { AGUI_STREAM_METHOD, type AguiFrame } from '../../../shared/ws-protocol.ts';
import type { AguiEvent } from '../bl/agent/agent-library';
import type { AgentSession } from '../ws/agent-session';

type BroadcastCall = { method: string; params: unknown };

function fakeSession(): { session: AgentSession; calls: BroadcastCall[]; recorded: AguiEvent[] } {
  const calls: BroadcastCall[] = [];
  const recorded: AguiEvent[] = [];
  const session = {
    sessionKey: 'sess-1',
    broadcast: (message: BroadcastCall) => {
      calls.push(message);
    },
    recordA2uiEvent: (event: AguiEvent) => {
      recorded.push(event);
    },
  } as unknown as AgentSession;
  return { session, calls, recorded };
}

async function* streamOf(events: AguiEvent[]): AsyncGenerator<AguiEvent> {
  for (const ev of events) {
    yield ev;
  }
}

describe('consumeAguiStream', () => {
  it('broadcasts every event on the agui channel inside a responseId frame', async () => {
    const { session, calls, recorded } = fakeSession();
    const events: AguiEvent[] = [
      { type: 'RUN_STARTED', runId: 'r1' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'hi', role: 'assistant' },
      { type: 'RUN_FINISHED', x: { status: 'ok' } },
    ];

    await consumeAguiStream(session, streamOf(events), 'resp-42');

    assert.strictEqual(calls.length, 3);
    // every event is offered to the session's surface reduction (resync source)
    assert.strictEqual(recorded.length, 3);
    assert.ok(calls.every((c) => c.method === AGUI_STREAM_METHOD));
    const frames = calls.map((c) => c.params as AguiFrame<AguiEvent>);
    assert.ok(frames.every((f) => f.responseId === 'resp-42'));
    assert.strictEqual(frames[0].event.type, 'RUN_STARTED');
    assert.strictEqual(frames[2].event.type, 'RUN_FINISHED');
  });

  it('does not throw when the stream errors mid-iteration', async () => {
    const { session, calls } = fakeSession();
    async function* boom(): AsyncGenerator<AguiEvent> {
      yield { type: 'RUN_STARTED', runId: 'r1' };
      throw new Error('stream died');
    }

    await consumeAguiStream(session, boom(), 'resp-1');

    assert.strictEqual(calls.length, 1); // the pre-error event was broadcast
    assert.strictEqual((calls[0].params as AguiFrame<AguiEvent>).responseId, 'resp-1');
  });
});
