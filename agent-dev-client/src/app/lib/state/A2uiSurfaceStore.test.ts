import { test } from 'node:test';
import { autorun } from 'mobx';
import { strict as assert } from 'node:assert';
import { A2uiSurfaceStore } from './A2uiSurfaceStore.ts';
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';

// Fixture 1 — simple booking form, in order.
test('createSurface + updateComponents reproduce a simple form tree', () => {
  const store = new A2uiSurfaceStore();

  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, {
    surfaceId: 'booking_1',
    catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
    theme: { primaryColor: '#00BFFF' },
    version: 'v0.9',
  });
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 'booking_1',
    components: [
      { id: 'root', component: 'Column', children: ['title', 'email'] },
      { id: 'title', component: 'Text', text: 'Book an appointment', variant: 'h2' },
      { id: 'email', component: 'TextField', label: 'Email', value: { path: '/booking/email' } },
    ],
  });

  const surface = store.surfaces.get('booking_1');
  assert.ok(surface);
  assert.equal(
    surface.catalogId,
    'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
  );
  assert.deepEqual(surface.theme, { primaryColor: '#00BFFF' });
  assert.equal(surface.components.size, 3);
  assert.deepEqual(surface.components.get('root'), {
    id: 'root',
    component: 'Column',
    children: ['title', 'email'],
  });
});

// Fixture 2 — progressive streaming: dangling children, then arrival; wholesale replace.
test('progressive updates: dangling refs kept, later nodes fill in, updates replace wholesale', () => {
  const store = new A2uiSurfaceStore();
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { surfaceId: 's', catalogId: 'c' });

  // root arrives first, referencing children that do not exist yet
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [{ id: 'root', component: 'Column', children: ['a', 'b'] }],
  });
  assert.equal(store.surfaces.get('s')?.components.size, 1); // dangling refs are fine

  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [
      { id: 'a', component: 'Text', text: 'first' },
      { id: 'b', component: 'Text', text: 'second' },
    ],
  });
  assert.equal(store.surfaces.get('s')?.components.size, 3);

  // wholesale replace: the new node has NO `variant`; nothing merges from the old one
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [{ id: 'a', component: 'Text', text: 'replaced' }],
  });
  assert.deepEqual(store.surfaces.get('s')?.components.get('a'), {
    id: 'a',
    component: 'Text',
    text: 'replaced',
  });
});

// Fixture 3 — lifecycle + defensive semantics.
test('delete, recreate, unknown-surface update, and malformed nodes behave per spec', () => {
  const store = new A2uiSurfaceStore();

  // update for unknown surface → ignored
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 'ghost',
    components: [{ id: 'root', component: 'Text' }],
  });
  assert.equal(store.surfaces.size, 0);

  // delete unknown → no-op
  store.applySurfaceEvent(A2UI_EVENT_NAMES.deleteSurface, { surfaceId: 'ghost' });
  assert.equal(store.surfaces.size, 0);

  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { surfaceId: 's', catalogId: 'c1' });
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [
      { id: 'root', component: 'Text' },
      { component: 'Text' }, // no id → skipped
      { id: 'x' }, // no component → skipped
      'garbage', // not a record → skipped
    ],
  });
  assert.equal(store.surfaces.get('s')?.components.size, 1);

  // recreate with same surfaceId → new catalogId immediately, but the previous
  // components stay mounted until the replacing nodes arrive. Emptying here
  // would be observable, and an observable empty surface unmounts the tree and
  // discards whatever the visitor had typed.
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { surfaceId: 's', catalogId: 'c2' });
  assert.equal(store.surfaces.get('s')?.catalogId, 'c2');
  assert.equal(store.surfaces.get('s')?.components.size, 1, 'previous tree held, not emptied');

  // ...and the following update REPLACES wholesale rather than merging, so a
  // node absent from the new composition is gone rather than orphaned.
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [{ id: 'fresh-root', component: 'Text' }],
  });
  assert.deepEqual([...(store.surfaces.get('s')?.components.keys() ?? [])], ['fresh-root']);

  store.applySurfaceEvent(A2UI_EVENT_NAMES.deleteSurface, { surfaceId: 's' });
  assert.equal(store.surfaces.size, 0);

  // malformed top-level payloads → dropped silently
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { catalogId: 'no-id' });
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, 'nonsense');
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, { surfaceId: 's' }); // no components array
  assert.equal(store.surfaces.size, 0);
});

// New reference on every change (MobX observable.ref contract).
test('surfaces map is replaced, not mutated, on every change', () => {
  const store = new A2uiSurfaceStore();
  const before = store.surfaces;
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { surfaceId: 's', catalogId: 'c' });
  assert.notEqual(store.surfaces, before);
  assert.equal(before.size, 0);
});

// Turn-rail association (stage shell): the surface remembers which turn made it.
test('stamps the responseId of the createSurface frame onto the surface record', () => {
  const store = new A2uiSurfaceStore();
  store.applySurfaceEvent(
    A2UI_EVENT_NAMES.createSurface,
    { surfaceId: 's', catalogId: 'c' },
    'resp-1',
  );
  assert.equal(store.surfaces.get('s')?.responseId, 'resp-1');

  // updateComponents does not carry a responseId of its own — the surface keeps
  // the one it was created with.
  store.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
    surfaceId: 's',
    components: [{ id: 'root', component: 'Text' }],
  });
  assert.equal(store.surfaces.get('s')?.responseId, 'resp-1');
});

test('createSurface without a responseId leaves it undefined', () => {
  const store = new A2uiSurfaceStore();
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, { surfaceId: 's', catalogId: 'c' });
  assert.equal(store.surfaces.get('s')?.responseId, undefined);
});

test('applySurfaceEvents writes the observable ONCE for a create+update pair', () => {
  const store = new A2uiSurfaceStore();
  const seen: number[] = [];
  const stop = autorun(() => {
    seen.push(store.surfaces.size);
  });

  store.applySurfaceEvents(
    [
      {
        name: A2UI_EVENT_NAMES.createSurface,
        value: { surfaceId: 's1', catalogId: 'cat' },
      },
      {
        name: A2UI_EVENT_NAMES.updateComponents,
        value: {
          surfaceId: 's1',
          components: [
            { id: 'root', component: 'Column', children: ['Form-abc'] },
            { id: 'Form-abc', component: 'Form' },
          ],
        },
      },
    ],
    'r1',
  );

  stop();
  assert.equal(seen.length, 2, 'one initial autorun + exactly one write for the whole batch');
  assert.equal(store.surfaces.get('s1')?.components.size, 2);
});

test('REGRESSION: a re-render never exposes an emptied surface between the pair', () => {
  const store = new A2uiSurfaceStore();
  const pair = (responseId: string) => [
    { name: A2UI_EVENT_NAMES.createSurface, value: { surfaceId: 's1', catalogId: 'cat' } },
    {
      name: A2UI_EVENT_NAMES.updateComponents,
      value: {
        surfaceId: 's1',
        components: [
          { id: 'root', component: 'Column', children: ['Form-abc'] },
          { id: 'Form-abc', component: 'Form' },
        ],
      },
    },
  ];

  store.applySurfaceEvents(pair('r1'), 'r1');

  const sizes: number[] = [];
  const stop = autorun(() => {
    sizes.push(store.surfaces.get('s1')?.components.size ?? -1);
  });
  store.applySurfaceEvents(pair('r2'), 'r2');
  stop();

  assert.equal(
    sizes.includes(0),
    false,
    'an observable empty surface unmounts the tree and discards typed input',
  );
});

test('applySurfaceEvent still works for a single event', () => {
  const store = new A2uiSurfaceStore();
  store.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, {
    surfaceId: 's2',
    catalogId: 'cat',
  });
  assert.equal(store.surfaces.get('s2')?.catalogId, 'cat');
});
