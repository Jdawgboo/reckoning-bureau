import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { NarrationStore } from './NarrationStore.ts';
import type { AguiEvent } from '../../../../vendor/agent-library/agui/events.ts';
import {
  ContentType,
  type AgentContent,
  type ComponentStreaming,
} from '../../../../vendor/agent-library/types/content.ts';

function toolCallStart(toolCallName: string): AguiEvent {
  return { type: 'TOOL_CALL_START', toolCallId: 'tc-1', toolCallName };
}

test('TOOL_CALL_START for a Render* tool maps to the screen-prep line', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('RenderServiceCatalog'));
  assert.deepEqual(store.line, { kind: 'message', message: 'screenReady' });
});

test('TOOL_CALL_START for a records/log tool maps to the saving line', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('Records'));
  assert.deepEqual(store.line, { kind: 'message', message: 'savingDetails' });

  const store2 = new NarrationStore();
  store2.handle(toolCallStart('AppendLogEntry'));
  assert.deepEqual(store2.line, { kind: 'message', message: 'savingDetails' });
});

test('TOOL_CALL_START for an unmapped tool falls back to the default line', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('FooBarTool'));
  assert.deepEqual(store.line, { kind: 'message', message: 'thinking' });
});

test('RUN_FINISHED clears the line', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('RenderServiceCatalog'));
  store.handle({ type: 'RUN_FINISHED', x: { status: 'ok' } });
  assert.equal(store.line, null);
});

test('RUN_ERROR clears the line', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('RenderServiceCatalog'));
  store.handle({ type: 'RUN_ERROR', message: 'boom' });
  assert.equal(store.line, null);
});

test('other event types do not affect the line', () => {
  const store = new NarrationStore();
  store.handle({ type: 'STEP_STARTED', stepName: 'step-0' });
  assert.equal(store.line, null);
  store.handle(toolCallStart('RenderServiceCatalog'));
  store.handle({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'hi', role: 'assistant' });
  assert.deepEqual(store.line, { kind: 'message', message: 'screenReady' });
});

function researchPart(
  state: ComponentStreaming['state'],
  props: Record<string, unknown>,
  componentName = 'DeepResearch',
): AgentContent {
  return {
    type: ContentType.Component,
    messageId: 'm-1',
    componentName,
    props,
    streaming: { toolName: componentName, toolCallId: 'c-1', state },
  };
}

test('handleToolPart sets a live progress line while the part is active', () => {
  const store = new NarrationStore();
  store.handleToolPart(
    researchPart('output-pending', {
      currentSearch: 'brake suppliers',
      searchCount: 3,
      sources: [{}, {}],
    }),
  );
  assert.deepEqual(store.line, {
    kind: 'message',
    message: 'researching',
    values: { currentSearch: 'brake suppliers', searchCount: 3, sourceCount: 2 },
  });
});

test('handleToolPart shows the duration hint before the first search lands', () => {
  const store = new NarrationStore();
  store.handleToolPart(researchPart('output-pending', {}));
  assert.deepEqual(store.line, { kind: 'message', message: 'researchingInitial' });
});

test('handleToolPart ignores final states and unregistered components', () => {
  const store = new NarrationStore();
  store.handleToolPart(researchPart('output-available', { currentSearch: 'x' }));
  assert.equal(store.line, null);
  store.handleToolPart(researchPart('output-pending', {}, 'Grep'));
  assert.equal(store.line, null);
});

test('RUN_FINISHED clears a tool-part progress line', () => {
  const store = new NarrationStore();
  store.handleToolPart(researchPart('output-pending', {}));
  store.handle({ type: 'RUN_FINISHED', x: { status: 'ok' } });
  assert.equal(store.line, null);
});

test('RUN_STARTED sets the Thinking baseline', () => {
  const store = new NarrationStore();
  store.handle({ type: 'RUN_STARTED', runId: 'r1' });
  assert.deepEqual(store.line, { kind: 'message', message: 'thinking' });
});

test('TOOL_CALL_END narrates for non-streaming tools that skip START', () => {
  const store = new NarrationStore();
  store.handle({ type: 'RUN_STARTED' } as AguiEvent);
  store.handle({ type: 'TOOL_CALL_END', toolCallId: 'g1', x: { toolName: 'Grep' } } as AguiEvent);
  assert.deepEqual(store.line, { kind: 'message', message: 'checkingNotes' });
});

test('TOOL_CALL_END keeps the current line when the tool has no phrase', () => {
  const store = new NarrationStore();
  store.handle(toolCallStart('RenderServiceCatalog'));
  store.handle({
    type: 'TOOL_CALL_END',
    toolCallId: 'x1',
    x: { toolName: 'UnknownTool' },
  } as AguiEvent);
  assert.deepEqual(store.line, { kind: 'message', message: 'screenReady' });
});

test('handleToolPart prefers a producer-authored progress fact over process narration', () => {
  const store = new NarrationStore();
  const part = researchPart('output-pending', { currentSearch: 'x' });
  part.progress = { text: 'Found 3 open slots for Tuesday' };
  store.handleToolPart(part);
  assert.deepEqual(store.line, {
    kind: 'authored',
    text: 'Found 3 open slots for Tuesday',
  });
});

test('handleToolPart shows a progress fact even on a settled part', () => {
  const store = new NarrationStore();
  const part = researchPart('output-available', {});
  part.progress = { text: 'Booked the appointment' };
  store.handleToolPart(part);
  assert.deepEqual(store.line, { kind: 'authored', text: 'Booked the appointment' });
});

test('handleToolPart shows a progress fact from a non-component tool content', () => {
  const store = new NarrationStore();
  store.handleToolPart({
    type: ContentType.Tool,
    messageId: 'm-2',
    tool: { name: 'Grep' },
    content: {},
    progress: { text: 'Scanned 12 documents' },
  } as AgentContent);
  assert.deepEqual(store.line, { kind: 'authored', text: 'Scanned 12 documents' });
});

test('handleToolPart ignores a blank progress fact', () => {
  const store = new NarrationStore();
  const part = researchPart('output-pending', {});
  part.progress = { text: '   ' };
  store.handleToolPart(part);
  assert.deepEqual(store.line, { kind: 'message', message: 'researchingInitial' });
});
