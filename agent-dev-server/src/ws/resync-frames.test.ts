import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildResyncFrames } from './resync-frames.ts';
import {
  reduceSurfaceEvent,
  type ReducedSurface,
} from '../../vendor/agentplace-a2ui/surface-reduction.ts';

function surfacesFromEvents(
  events: Array<{ name: string; value: unknown }>,
): Map<string, ReducedSurface> {
  const surfaces = new Map<string, ReducedSurface>();
  for (const { name, value } of events) {
    reduceSurfaceEvent(surfaces, name, value);
  }
  return surfaces;
}

describe('buildResyncFrames', () => {
  it('emits uiState snapshot first, then create+update per live surface, all not run-scoped', () => {
    const surfaces = surfacesFromEvents([
      {
        name: 'agentplace.a2ui.createSurface',
        value: { surfaceId: 's1', catalogId: 'agent:custom-v1', placement: 'stage' },
      },
      {
        name: 'agentplace.a2ui.updateComponents',
        value: { surfaceId: 's1', components: [{ id: 'root', component: 'SlotPicker' }] },
      },
    ]);

    const frames = buildResyncFrames({ surfaces: { s1: { selectedSlot: '10:00' } } }, surfaces);

    assert.strictEqual(frames.length, 3);
    assert.ok(frames.every((f) => f.responseId === ''));

    assert.strictEqual(frames[0]?.event.type, 'STATE_SNAPSHOT');
    const custom1 = frames[1]?.event;
    const custom2 = frames[2]?.event;
    assert.ok(custom1?.type === 'CUSTOM' && custom1.name === 'agentplace.a2ui.createSurface');
    assert.ok(custom2?.type === 'CUSTOM' && custom2.name === 'agentplace.a2ui.updateComponents');
    assert.deepStrictEqual(custom2.value, {
      surfaceId: 's1',
      components: [{ id: 'root', component: 'SlotPicker' }],
    });
  });

  it('deleted surfaces do not resync; empty session yields no frames', () => {
    const surfaces = surfacesFromEvents([
      { name: 'agentplace.a2ui.createSurface', value: { surfaceId: 's1', catalogId: 'c' } },
      { name: 'agentplace.a2ui.deleteSurface', value: { surfaceId: 's1' } },
    ]);

    assert.deepStrictEqual(buildResyncFrames(null, surfaces), []);
    assert.deepStrictEqual(buildResyncFrames({}, new Map()), []);
  });
});
