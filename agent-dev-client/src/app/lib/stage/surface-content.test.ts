import { describe, it } from 'node:test';
import assert from 'node:assert';
import { surfaceRendersSomething } from './surface-content.ts';
import type { A2uiSurfaceRecord } from '../state/A2uiSurfaceStore.ts';

function surface(nodes: Array<Record<string, unknown>>): A2uiSurfaceRecord {
  const components = new Map<string, never>();
  for (const node of nodes) {
    components.set(String(node.id), node as never);
  }
  return { surfaceId: 's1', catalogId: 'c', components } as A2uiSurfaceRecord;
}

describe('surfaceRendersSomething', () => {
  it('REGRESSION: a progressive first frame renders nothing', () => {
    const partial = surface([{ id: 'root', component: 'Column', children: [] }]);
    assert.strictEqual(surfaceRendersSomething(partial), false);
  });

  it('REGRESSION: a container still holding only unresolved ids renders nothing', () => {
    const partial = surface([{ id: 'root', component: 'Column', children: ['not-here-yet'] }]);
    assert.strictEqual(surfaceRendersSomething(partial), false);
  });

  it('a single-component screen is its own root and does render', () => {
    const table = surface([{ id: 'root', component: 'Table', rows: [] }]);
    assert.strictEqual(surfaceRendersSomething(table), true);
  });

  it('renders once the first section resolves, even with one still pending', () => {
    const growing = surface([
      { id: 'root', component: 'Column', children: ['TextBlock-0', 'pending-1'] },
      { id: 'TextBlock-0', component: 'TextBlock', title: 'Hi' },
    ]);
    assert.strictEqual(surfaceRendersSomething(growing), true);
  });

  it('an empty surface renders nothing', () => {
    assert.strictEqual(surfaceRendersSomething(surface([])), false);
  });
});
