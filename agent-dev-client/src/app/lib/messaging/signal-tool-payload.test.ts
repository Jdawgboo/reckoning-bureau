import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveSignalToolUpdate,
  VOICE_TOOL_NAME,
  MEMORY_BANK_TOOL_NAME,
} from './signal-tool-payload.ts';

test('resolves a memory update from Tool-content shaped payload (content.content)', () => {
  const update = resolveSignalToolUpdate(
    MEMORY_BANK_TOOL_NAME,
    { summary: 'User has a dog named Max' },
    'tool',
  );
  assert.deepEqual(update, { kind: 'memory', summary: 'User has a dog named Max' });
});

test('resolves a memory update from Component-content shaped payload (props)', () => {
  const update = resolveSignalToolUpdate(
    MEMORY_BANK_TOOL_NAME,
    { summary: 'User prefers concise responses' },
    'component',
  );
  assert.deepEqual(update, { kind: 'memory', summary: 'User prefers concise responses' });
});

test('resolves a voice update from Tool-content shaped payload', () => {
  const update = resolveSignalToolUpdate(
    VOICE_TOOL_NAME,
    { text: "We're open until six." },
    'tool',
  );
  assert.deepEqual(update, { kind: 'voice', text: "We're open until six." });
});

test('returns null for an unrelated tool name', () => {
  const update = resolveSignalToolUpdate('someOtherTool', { summary: 'irrelevant' }, 'tool');
  assert.equal(update, null);
});

test('returns null when the matching tool payload is missing its field', () => {
  assert.equal(resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, {}, 'tool'), null);
  assert.equal(resolveSignalToolUpdate(VOICE_TOOL_NAME, {}, 'tool'), null);
});

test('returns null when payload is not a record (undefined, array, primitive)', () => {
  assert.equal(resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, undefined, 'tool'), null);
  assert.equal(resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, ['summary'], 'tool'), null);
  assert.equal(resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, 'summary', 'tool'), null);
});

test('returns null when the field is present but not a string', () => {
  assert.equal(resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, { summary: 42 }, 'tool'), null);
});

test('a known signal tool on its registered channel (tool) does not warn', () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnCalls.push(args);
  try {
    resolveSignalToolUpdate(MEMORY_BANK_TOOL_NAME, { summary: 'User likes tea' }, 'tool');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnCalls.length, 0);
});

test('a known signal tool arriving on the WRONG channel warns loudly but still resolves (best-effort)', () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnCalls.push(args);
  let update: ReturnType<typeof resolveSignalToolUpdate>;
  try {
    update = resolveSignalToolUpdate(
      MEMORY_BANK_TOOL_NAME,
      { summary: 'User has a dog named Max' },
      'component',
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(update, { kind: 'memory', summary: 'User has a dog named Max' });
  assert.equal(warnCalls.length, 1);
  const [message] = warnCalls[0];
  assert.equal(typeof message, 'string');
  assert.match(message as string, /\[signal-tool]/);
  assert.match(message as string, /persistToMemoryBank/);
  assert.match(message as string, /arrived as Component/);
  assert.match(message as string, /registered as tool-channel/);
});

test('the voice tool arriving on the WRONG channel also warns and still resolves', () => {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnCalls.push(args);
  let update: ReturnType<typeof resolveSignalToolUpdate>;
  try {
    update = resolveSignalToolUpdate(
      VOICE_TOOL_NAME,
      { text: "We're open until six." },
      'component',
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(update, { kind: 'voice', text: "We're open until six." });
  assert.equal(warnCalls.length, 1);
});
