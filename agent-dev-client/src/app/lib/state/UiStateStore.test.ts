import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { UiStateStore } from './UiStateStore.ts';
import type { AguiEvent } from '../../../../vendor/agent-library/agui/events.ts';

function snapshot(value: Record<string, unknown>): AguiEvent {
  return { type: 'STATE_SNAPSHOT', scope: '/uiState', snapshot: value };
}

test('applies a STATE_SNAPSHOT as a full replace', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c' }, step: 1 }));
  assert.deepEqual(store.state, { form: { email: 'a@b.c' }, step: 1 });

  store.applyStateEvent(snapshot({ step: 2 }));
  assert.deepEqual(store.state, { step: 2 }); // replace, not merge
});

test('coerces a non-object snapshot to empty', () => {
  const store = new UiStateStore();
  store.applyStateEvent({ type: 'STATE_SNAPSHOT', scope: '/uiState', snapshot: 42 });
  assert.deepEqual(store.state, {});
});

test('get() resolves a JSON pointer, undefined for missing paths', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c' } }));
  assert.equal(store.get('/form/email'), 'a@b.c');
  assert.deepEqual(store.get('/form'), { email: 'a@b.c' });
  assert.equal(store.get('/form/missing'), undefined);
  assert.equal(store.get('/nope/deep'), undefined);
});

test('applies a STATE_DELTA (add/replace/remove by pointer)', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c', keep: true } }));

  store.applyStateEvent({
    type: 'STATE_DELTA',
    scope: '/uiState',
    patch: [
      { op: 'replace', path: '/form/email', value: 'x@y.z' },
      { op: 'add', path: '/form/name', value: 'Jane' },
      { op: 'remove', path: '/form/keep' },
    ],
  });

  assert.deepEqual(store.state, { form: { email: 'x@y.z', name: 'Jane' } });
});

test('STATE_DELTA does not mutate the previous state object (new ref)', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ n: 1 }));
  const before = store.state;
  store.applyStateEvent({
    type: 'STATE_DELTA',
    scope: '/uiState',
    patch: [{ op: 'replace', path: '/n', value: 2 }],
  });
  assert.equal(before.n, 1); // old ref untouched
  assert.equal(store.state.n, 2);
});

test('setLocal writes through a pointer immutably (client-originated)', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ surfaces: { s1: { booking: { email: 'a@b.c' } } } }));
  const before = store.state;
  store.setLocal('/surfaces/s1/booking/email', 'x@y.z');
  assert.equal(store.get('/surfaces/s1/booking/email'), 'x@y.z');
  assert.equal(
    (before as { surfaces: { s1: { booking: { email: string } } } }).surfaces.s1.booking.email,
    'a@b.c',
  );
});

// ---- dirty overlay ----

test('a snapshot does not clobber a dirty (unsynced) pointer', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c', step: 1 } }));
  store.setLocal('/form/email', 'typing@example.com'); // local, unsynced edit

  // A server-side snapshot arrives from elsewhere (another tab, an agent
  // write) that still carries the OLD email — the local edit must survive.
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c', step: 2 } }));

  assert.equal(store.get('/form/email'), 'typing@example.com'); // dirty overlay wins
  assert.equal(store.get('/form/step'), 2); // non-dirty paths still replaced
});

test('a delta does not clobber a dirty pointer either', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c' } }));
  store.setLocal('/form/email', 'typing@example.com');

  store.applyStateEvent({
    type: 'STATE_DELTA',
    scope: '/uiState',
    patch: [{ op: 'add', path: '/form/name', value: 'Jane' }],
  });

  assert.equal(store.get('/form/email'), 'typing@example.com');
  assert.equal(store.get('/form/name'), 'Jane');
});

test('a dirty pointer prunes once the incoming value equals the local one', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c' } }));
  store.setLocal('/form/email', 'synced@example.com');

  // The server catches up to the same value the visitor typed.
  store.applyStateEvent(snapshot({ form: { email: 'synced@example.com' } }));
  assert.equal(store.get('/form/email'), 'synced@example.com');

  // Now a later snapshot with a DIFFERENT value is free to win — the pointer
  // was pruned from the dirty set, proving it is no longer protected.
  store.applyStateEvent(snapshot({ form: { email: 'agent-write@example.com' } }));
  assert.equal(store.get('/form/email'), 'agent-write@example.com');
});

test('markSynced clears the dirty overlay so the next snapshot always wins', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c' } }));
  store.setLocal('/form/email', 'typing@example.com');

  store.markSynced();

  store.applyStateEvent(snapshot({ form: { email: 'server@example.com' } }));
  assert.equal(store.get('/form/email'), 'server@example.com');
});

test('non-dirty paths are replaced normally alongside a protected dirty pointer', () => {
  const store = new UiStateStore();
  store.applyStateEvent(snapshot({ form: { email: 'a@b.c', notes: 'old' } }));
  store.setLocal('/form/email', 'typing@example.com');

  store.applyStateEvent(snapshot({ form: { email: 'a@b.c', notes: 'new from agent' } }));

  assert.equal(store.get('/form/email'), 'typing@example.com');
  assert.equal(store.get('/form/notes'), 'new from agent');
});

test('syncableState omits pointers the caller marks sensitive', () => {
  const store = new UiStateStore();
  store.setLocal('/surfaces/s1/form/email', 'a@b.c');
  store.setLocal('/surfaces/s1/form/cardNumber', '4111111111111111');

  const doc = store.syncableState((pointer) => pointer.endsWith('/cardNumber'));

  assert.equal(
    JSON.stringify(doc).includes('4111'),
    false,
    'a card number must never leave the browser',
  );
  assert.equal(JSON.stringify(doc).includes('a@b.c'), true);
});

test('syncableState leaves the live state untouched', () => {
  const store = new UiStateStore();
  store.setLocal('/surfaces/s1/form/cardNumber', '4111111111111111');
  store.syncableState(() => true);
  assert.equal(store.get('/surfaces/s1/form/cardNumber'), '4111111111111111');
});

test('REGRESSION: a blur sync must not clear the dirty overlay', () => {
  const store = new UiStateStore();
  store.setLocal('/surfaces/s1/form/name', 'Anna');
  store.syncableState(() => false);

  // A server snapshot in flight when the visitor typed would otherwise win.
  store.applyStateEvent({
    type: 'STATE_SNAPSHOT',
    snapshot: { surfaces: { s1: { form: { name: '' } } } },
  } as never);

  assert.equal(store.get('/surfaces/s1/form/name'), 'Anna');
});
