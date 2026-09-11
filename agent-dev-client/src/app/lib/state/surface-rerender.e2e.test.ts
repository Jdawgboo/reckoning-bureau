/**
 * End-to-end across the seam that matters: the SERVER composes a render, the
 * events cross as they do on the wire, the CLIENT store applies them, and the
 * real walker resolves what the visitor would see.
 *
 * Unit tests on either side passed while the pair was still capable of showing
 * a blank screen — this exercises them together, on the exact sequence a
 * re-render produces (`createSurface` then `updateComponents`, twice, same
 * `surfaceId`), which is the shape live logs show the model actually emitting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { A2uiSurfaceStore } from './A2uiSurfaceStore.ts';
import { resolveSurface } from '../../../../vendor/agentplace-a2ui/walker.ts';
import { buildSurfaceEvents } from '../../../../../agent-dev-server/src/bl/tools/impl/render-surface.helpers.ts';
import { createSectionStackContract } from '../../../../../agent-dev-server/src/bl/builtin-catalog/section-stack.ts';
import type { ComponentContract } from '../../../../vendor/agentplace-a2ui/contract-schema.ts';

const TEXT: ComponentContract = {
  component: 'TextBlock',
  purpose: 'Prose.',
  props: { body: { type: 'string', required: true, description: 'Body' } },
  publishes: {},
  actions: {},
  fallbackTemplate: (props) => String(props.body ?? ''),
};

const SIGNUP: ComponentContract = {
  component: 'Signup',
  purpose: 'Takes details.',
  props: { fields: { type: 'array', required: true, items: {}, description: 'Fields' } },
  publishes: { '/signup/{fieldId}': { valueType: 'string' } },
  actions: { submit: { context: {} } },
  fallbackTemplate: () => 'Signup',
};

const CONTRACT = createSectionStackContract({ TextBlock: TEXT, Signup: SIGNUP });

function render(
  store: A2uiSurfaceStore,
  sections: Array<{ component: string; props: Record<string, unknown> }>,
  responseId: string,
  carryForward: unknown[] | null = null,
) {
  const built = buildSurfaceEvents({
    surfaceId: 'demo-dashboard',
    contract: CONTRACT,
    catalogId: 'agentplace:builtin-v1',
    props: { sections },
    carryForward,
  });
  assert.strictEqual(built.ok, true, built.ok === false ? built.error : '');
  if (built.ok !== true) {
    return;
  }
  // Applied one at a time, exactly as `AguiClientConsumer` dispatches them.
  for (const event of built.events) {
    store.applySurfaceEvent(event.name, event.value, responseId);
  }
}

function visibleComponents(store: A2uiSurfaceStore): string[] {
  const surface = store.surfaces.get('demo-dashboard');
  if (!surface) {
    return [];
  }
  const tree = resolveSurface(surface, {});
  return (tree?.children ?? []).map((child) => child.component);
}

describe('e2e — re-rendering a surface', () => {
  it('shows the SECOND render, not a blank screen', () => {
    const store = new A2uiSurfaceStore();
    render(store, [{ component: 'TextBlock', props: { body: 'First' } }], 'r1');
    assert.deepStrictEqual(visibleComponents(store), ['TextBlock']);

    render(
      store,
      [
        { component: 'TextBlock', props: { body: 'Second' } },
        { component: 'Signup', props: { fields: [{ id: 'email' }] } },
      ],
      'r2',
    );
    assert.deepStrictEqual(visibleComponents(store), ['TextBlock', 'Signup']);
  });

  it('never exposes an empty screen between the two events', () => {
    const store = new A2uiSurfaceStore();
    render(store, [{ component: 'TextBlock', props: { body: 'First' } }], 'r1');

    const built = buildSurfaceEvents({
      surfaceId: 'demo-dashboard',
      contract: CONTRACT,
      catalogId: 'agentplace:builtin-v1',
      props: { sections: [{ component: 'TextBlock', props: { body: 'Second' } }] },
    });
    assert.strictEqual(built.ok, true);
    if (built.ok !== true) {
      return;
    }
    // Apply ONLY the createSurface half — the state a render between the two
    // events would paint.
    store.applySurfaceEvent(built.events[0].name, built.events[0].value, 'r2');
    assert.deepStrictEqual(
      visibleComponents(store),
      ['TextBlock'],
      'the previous tree must stay mounted until the replacement lands',
    );
  });

  it('drops the old composition rather than orphaning it', () => {
    const store = new A2uiSurfaceStore();
    render(
      store,
      [
        { component: 'TextBlock', props: { body: 'First' } },
        { component: 'Signup', props: { fields: [{ id: 'email' }] } },
      ],
      'r1',
    );
    render(store, [{ component: 'TextBlock', props: { body: 'Only prose now' } }], 'r2');

    assert.deepStrictEqual(visibleComponents(store), ['TextBlock']);
    assert.strictEqual(
      store.surfaces.get('demo-dashboard')?.components.size,
      2,
      'root + one section — the dropped Signup is gone, not orphaned',
    );
  });

  it('keeps a carried-forward form identical across renders, so React reuses its DOM', () => {
    const store = new A2uiSurfaceStore();
    const form = { component: 'Signup', props: { fields: [{ id: 'email' }] } };
    render(store, [{ component: 'TextBlock', props: { body: 'First' } }, form], 'r1');
    const before = [...(store.surfaces.get('demo-dashboard')?.components.keys() ?? [])];

    render(store, [{ component: 'TextBlock', props: { body: 'An answer' } }], 'r2', [form]);
    const after = [...(store.surfaces.get('demo-dashboard')?.components.keys() ?? [])];

    const signupBefore = before.find((id) => id.startsWith('Signup-'));
    const signupAfter = after.find((id) => id.startsWith('Signup-'));
    assert.ok(signupBefore, 'the form was on screen');
    assert.strictEqual(signupAfter, signupBefore, 'same node id ⇒ same DOM ⇒ typed input survives');
    assert.deepStrictEqual(visibleComponents(store), ['TextBlock', 'Signup']);
  });
});
