import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AguiClientConsumer } from './AguiClientConsumer.ts';
import type { AguiFrame } from '../../../../../shared/ws-protocol.ts';
import type { AgentStreamContent } from '../services/websocket-client.types';

function collect(): { emit: (c: AgentStreamContent) => void; items: AgentStreamContent[] } {
  const items: AgentStreamContent[] = [];
  return { emit: (c) => items.push(c), items };
}

function frame(responseId: string, event: unknown): AguiFrame {
  return { responseId, event };
}

test('projects a text chunk into text content stamped with the frame responseId', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  consumer.consume(
    frame('resp-1', {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm1',
      delta: 'hello',
      role: 'assistant',
    }),
  );

  assert.equal(items.length, 1);
  const c = items[0] as { type: string; messageId: string; content: string; responseId?: string };
  assert.equal(c.type, 'TXT');
  assert.equal(c.messageId, 'm1');
  assert.equal(c.content, 'hello');
  assert.equal(c.responseId, 'resp-1');
});

test('synthesizes a finish signal (with responseId) on RUN_FINISHED', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  consumer.consume(frame('resp-7', { type: 'RUN_FINISHED', x: { status: 'ok' } }));

  assert.deepEqual(items, [{ type: 'finish', messageId: 'finish', responseId: 'resp-7' }]);
});

test('synthesizes an error signal (with message + responseId) on RUN_ERROR', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  consumer.consume(frame('resp-9', { type: 'RUN_ERROR', message: 'boom' }));

  assert.deepEqual(items, [
    { type: 'error', messageId: 'error', error: 'boom', responseId: 'resp-9' },
  ]);
});

test('appends the verbatim content carried by the agentplace.content envelope', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  const userMessage = {
    type: 'TXT',
    messageId: 'user-1',
    content: 'hi there',
    role: 'user',
    responseId: 'resp-2',
  };
  consumer.consume(
    frame('resp-2', {
      type: 'CUSTOM',
      name: 'agentplace.content',
      value: { content: userMessage },
    }),
  );

  assert.deepEqual(items, [userMessage]);
});

test('ignores non-AG-UI payloads without emitting', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  consumer.consume(frame('resp-3', { not: 'an event' }));
  consumer.consume(frame('resp-3', null));

  assert.equal(items.length, 0);
});

test('routes STATE events to onState, never emitting them as content', () => {
  const { emit, items } = collect();
  const states: unknown[] = [];
  const consumer = new AguiClientConsumer(emit, (ev) => states.push(ev));

  consumer.consume(frame('r', { type: 'STATE_SNAPSHOT', scope: '/uiState', snapshot: { a: 1 } }));
  consumer.consume(
    frame('r', {
      type: 'STATE_DELTA',
      scope: '/uiState',
      patch: [{ op: 'replace', path: '/a', value: 2 }],
    }),
  );

  assert.equal(items.length, 0); // no content emitted
  assert.equal(states.length, 2);
  assert.equal((states[0] as { type: string }).type, 'STATE_SNAPSHOT');
  assert.equal((states[1] as { type: string }).type, 'STATE_DELTA');
});

test('STATE events are inert when no onState sink is provided', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit); // no onState
  consumer.consume(frame('r', { type: 'STATE_SNAPSHOT', scope: '/uiState', snapshot: {} }));
  assert.equal(items.length, 0);
});

test('RUN_STARTED / STEP lifecycle events project no content', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);

  consumer.consume(frame('r', { type: 'RUN_STARTED', runId: 'r' }));
  consumer.consume(frame('r', { type: 'STEP_STARTED', stepName: 'step-0' }));
  consumer.consume(frame('r', { type: 'STEP_FINISHED', stepName: 'step-0' }));

  assert.equal(items.length, 0);
});

test('routes a2ui CUSTOM events to onSurface, never to content', () => {
  const { emit, items } = collect();
  const surfaces: Array<{ name: string; value: unknown }> = [];
  const consumer = new AguiClientConsumer(emit, undefined, (name, value) =>
    surfaces.push({ name, value }),
  );

  consumer.consume(
    frame('r', {
      type: 'CUSTOM',
      name: 'agentplace.a2ui.createSurface',
      value: { surfaceId: 's', catalogId: 'c' },
    }),
  );

  assert.equal(items.length, 0);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].name, 'agentplace.a2ui.createSurface');
});

test('stamps the frame responseId onto onSurface calls', () => {
  const { emit } = collect();
  const surfaces: Array<{ name: string; responseId: string | undefined }> = [];
  const consumer = new AguiClientConsumer(emit, undefined, (name, _value, responseId) =>
    surfaces.push({ name, responseId }),
  );

  consumer.consume(
    frame('resp-42', {
      type: 'CUSTOM',
      name: 'agentplace.a2ui.createSurface',
      value: { surfaceId: 's', catalogId: 'c' },
    }),
  );

  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].responseId, 'resp-42');
});

test('non-a2ui CUSTOM events still reach the projector (content envelope)', () => {
  const { emit, items } = collect();
  const surfaces: unknown[] = [];
  const consumer = new AguiClientConsumer(emit, undefined, (name) => surfaces.push(name));

  const userMessage = { type: 'TXT', messageId: 'u1', content: 'hi', role: 'user' };
  consumer.consume(
    frame('r', { type: 'CUSTOM', name: 'agentplace.content', value: { content: userMessage } }),
  );

  assert.equal(surfaces.length, 0);
  assert.deepEqual(items, [{ ...userMessage, responseId: 'r' }]);
});

test('a2ui CUSTOM events are inert when no onSurface sink is provided', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);
  consumer.consume(
    frame('r', {
      type: 'CUSTOM',
      name: 'agentplace.a2ui.deleteSurface',
      value: { surfaceId: 's' },
    }),
  );
  assert.equal(items.length, 0);
});

test('the onEvent tap sees every valid event, in order, before routing', () => {
  const { emit } = collect();
  const seen: string[] = [];
  const consumer = new AguiClientConsumer(emit, undefined, undefined, (ev) => seen.push(ev.type));

  consumer.consume(frame('r', { type: 'RUN_STARTED', runId: 'r' }));
  consumer.consume(
    frame('r', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'hi', role: 'assistant' }),
  );
  consumer.consume(frame('r', { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'X' }));
  consumer.consume(frame('r', { type: 'STATE_SNAPSHOT', scope: '/uiState', snapshot: {} }));
  consumer.consume(frame('r', { type: 'RUN_FINISHED', x: { status: 'ok' } }));

  assert.deepEqual(seen, [
    'RUN_STARTED',
    'TEXT_MESSAGE_CHUNK',
    'TOOL_CALL_START',
    'STATE_SNAPSHOT',
    'RUN_FINISHED',
  ]);
});

test('the onEvent tap is a no-op when absent (no behavior change otherwise)', () => {
  const { emit, items } = collect();
  const consumer = new AguiClientConsumer(emit);
  consumer.consume(
    frame('r1', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'hi', role: 'assistant' }),
  );
  assert.equal(items.length, 1);
});
