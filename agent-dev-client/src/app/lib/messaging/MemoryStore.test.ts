import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryStore } from './MemoryStore.ts';

function makeStore(agentId = 'agent-1'): MemoryStore {
  const store = new MemoryStore();
  store.initialize(agentId);
  return store;
}

test('add() trims storage to the newest 15 entries, not just getAll()', () => {
  const store = makeStore();
  for (let i = 0; i < 20; i++) {
    store.add(`memory-${i}`);
  }
  assert.equal(store.memories.length, 15);
  assert.deepEqual(
    store.memories.map((m) => m.summary),
    Array.from({ length: 15 }, (_, i) => `memory-${i + 5}`),
  );
});

test('getAll() returns the newest 15 in chronological order', () => {
  const store = makeStore();
  for (let i = 0; i < 20; i++) {
    store.add(`memory-${i}`);
  }
  assert.deepEqual(
    store.getAll().map((m) => m.summary),
    Array.from({ length: 15 }, (_, i) => `memory-${i + 5}`),
  );
});

test('getAll() returns [] before initialize()', () => {
  const store = new MemoryStore();
  assert.deepEqual(store.getAll(), []);
});

test('remove() drops a memory by id without affecting others', () => {
  const store = makeStore();
  store.add('keep me');
  store.add('drop me');
  const toDrop = store.memories.find((m) => m.summary === 'drop me');
  assert.ok(toDrop);
  store.remove(toDrop.id);
  assert.deepEqual(
    store.memories.map((m) => m.summary),
    ['keep me'],
  );
});

test('clear() empties the store', () => {
  const store = makeStore();
  store.add('one');
  store.add('two');
  store.clear();
  assert.deepEqual(store.memories, []);
});

test('add() does not append an exact duplicate — it refreshes the timestamp instead', () => {
  const store = makeStore();
  store.add('User likes coffee', 1_000);
  store.add('User likes coffee', 5_000);
  assert.equal(store.memories.length, 1);
  assert.equal(store.memories[0].summary, 'User likes coffee');
  assert.equal(store.memories[0].timestamp, 5_000);
});

test('add() treats a case/whitespace variant as a duplicate', () => {
  const store = makeStore();
  store.add('User   likes  Coffee', 1_000);
  store.add('  user likes coffee  ', 5_000);
  assert.equal(store.memories.length, 1);
  assert.equal(store.memories[0].timestamp, 5_000);
});

test('add() appends a genuinely different summary', () => {
  const store = makeStore();
  store.add('User likes coffee', 1_000);
  store.add('User likes tea', 2_000);
  assert.equal(store.memories.length, 2);
  assert.deepEqual(
    store.memories.map((m) => m.summary),
    ['User likes coffee', 'User likes tea'],
  );
});
