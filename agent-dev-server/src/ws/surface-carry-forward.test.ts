import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sectionsOnScreen, snapshotSurface } from './surface-carry-forward.ts';
import type { A2uiComponentNode } from '../../vendor/agentplace-a2ui/types.ts';
import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';

function surface(children: string[], nodes: A2uiComponentNode[]): ReducedSurface {
  const components = new Map<string, A2uiComponentNode>();
  components.set('root', { id: 'root', component: 'Column', children });
  for (const node of nodes) {
    components.set(node.id, node);
  }
  return { surfaceId: 's1', catalogId: 'c', components };
}

describe('sectionsOnScreen', () => {
  it('reports every composed section in screen order', () => {
    const result = sectionsOnScreen(
      surface(
        ['Prose-0', 'Signup-abc'],
        [
          { id: 'Prose-0', component: 'Prose', markdown: 'An answer' },
          { id: 'Signup-abc', component: 'Signup', fields: [{ id: 'email' }] },
        ],
      ),
    );
    assert.deepStrictEqual(result, [
      { component: 'Prose', props: { markdown: 'An answer' } },
      { component: 'Signup', props: { fields: [{ id: 'email' }] } },
    ]);
  });

  it('reports an input component that has no fields array', () => {
    const result = sectionsOnScreen(
      surface(['Slider-0'], [{ id: 'Slider-0', component: 'Slider', min: 1 }]),
    );
    assert.deepStrictEqual(result, [{ component: 'Slider', props: { min: 1 } }]);
  });

  it('does NOT filter display-only sections — that decision belongs to the tool layer', () => {
    const result = sectionsOnScreen(
      surface(['Prose-0'], [{ id: 'Prose-0', component: 'Prose', markdown: 'x' }]),
    );
    assert.deepStrictEqual(result, [{ component: 'Prose', props: { markdown: 'x' } }]);
  });

  it('ignores a dangling child id — a skeleton has nothing to preserve', () => {
    const result = sectionsOnScreen(surface(['pending-0'], []));
    assert.deepStrictEqual(result, []);
  });

  it('returns nothing for an unknown surface or a single-component root', () => {
    assert.deepStrictEqual(sectionsOnScreen(undefined), []);
    const single: ReducedSurface = {
      surfaceId: 's1',
      catalogId: 'c',
      components: new Map([['root', { id: 'root', component: 'Signup' }]]),
    };
    assert.deepStrictEqual(sectionsOnScreen(single), []);
  });

  it('reports a component it knows nothing about — the tool layer resolves contracts', () => {
    const result = sectionsOnScreen(
      surface(['Mystery-0'], [{ id: 'Mystery-0', component: 'Mystery', value: 1 }]),
    );
    assert.deepStrictEqual(result, [{ component: 'Mystery', props: { value: 1 } }]);
  });
});

describe('snapshotSurface', () => {
  it('separates single-root occupancy from SectionStack carry-forward', () => {
    const single: ReducedSurface = {
      surfaceId: 's1',
      catalogId: 'c',
      components: new Map([['root', { id: 'root', component: 'Signup' }]]),
    };
    assert.deepStrictEqual(snapshotSurface(single), { isPopulated: true, sections: [] });
  });

  it('reports empty structural states as unpopulated', () => {
    assert.deepStrictEqual(snapshotSurface(undefined), { isPopulated: false, sections: [] });
    assert.deepStrictEqual(snapshotSurface(surface([], [])), {
      isPopulated: false,
      sections: [],
    });
    assert.deepStrictEqual(snapshotSurface(surface(['pending'], [])), {
      isPopulated: false,
      sections: [],
    });
  });

  it('reports a populated stack and its ordered sections together', () => {
    assert.deepStrictEqual(
      snapshotSurface(
        surface(['Prose-0'], [{ id: 'Prose-0', component: 'Prose', markdown: 'An answer' }]),
      ),
      {
        isPopulated: true,
        sections: [{ component: 'Prose', props: { markdown: 'An answer' } }],
      },
    );
  });
});
