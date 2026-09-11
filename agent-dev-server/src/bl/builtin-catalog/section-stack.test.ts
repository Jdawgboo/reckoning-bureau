import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SECTION_STACK_NAME, createSectionStackContract, sectionNodeId } from './section-stack.ts';
import { BUILTIN_SURFACE_CONTRACTS } from './index.ts';
import {
  contractToFlatToolSchema,
  type ComponentContract,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { assertProviderSafeToolSchema } from '../tools/impl/schema-dialect-guards.ts';
import { buildSurfaceEvents } from '../tools/impl/render-surface.helpers.ts';
import {
  reduceSurfaceEvent,
  type ReducedSurface,
} from '../../../vendor/agentplace-a2ui/surface-reduction.ts';
import { resolveSurface } from '../../../vendor/agentplace-a2ui/walker.ts';

const AGENT_FIXTURE: ComponentContract = {
  component: 'ProseFixture',
  purpose: 'Prose fixture.',
  props: { title: { type: 'string', description: 'Title' } },
  fallbackTemplate: (props) => `## ${String(props.title ?? '')}`,
};

function stack(): ComponentContract {
  return createSectionStackContract({
    ProseFixture: AGENT_FIXTURE,
    ...BUILTIN_SURFACE_CONTRACTS,
  });
}

function validTableProps(): Record<string, unknown> {
  return {
    title: 'Prices',
    columns: [
      { header: 'Service', accessor: 's' },
      { header: 'Price', accessor: 'p' },
    ],
    rows: [['Tune-up', '$80']],
  };
}

function validOptionGridProps(): Record<string, unknown> {
  return {
    title: 'Pick one',
    options: [{ id: 'a', name: 'Option A' }],
  };
}

describe('createSectionStackContract', () => {
  it('describes the atomic-versus-progressive boundary to the model', () => {
    const purpose = stack().purpose;

    assert.match(purpose, /independently useful components/);
    assert.match(purpose, /ONE surface/);
    assert.match(purpose, /one tightly coupled contract/);
    assert.match(purpose, /live viewer on a new surface/);
    assert.match(purpose, /completed leading sections can appear/);
    assert.doesNotMatch(purpose, /Use whenever the visitor should see more than one block/);
  });

  it('derives the section enum from sub-contracts, excluding itself', () => {
    const withSelf = createSectionStackContract({
      ProseFixture: AGENT_FIXTURE,
      [SECTION_STACK_NAME]: stack(),
    });
    const schema = contractToFlatToolSchema(withSelf);
    const sections = (schema.properties as Record<string, Record<string, unknown>>).sections;
    const items = sections.items as { properties: Record<string, Record<string, unknown>> };
    assert.deepStrictEqual(items.properties.component.enum, ['ProseFixture']);
  });

  it('generates a provider-safe RenderSectionStack schema', () => {
    assertProviderSafeToolSchema(contractToFlatToolSchema(stack()), 'RenderSectionStack');
  });

  it('rejects unknown components, nesting, empty stacks, and bad section props', () => {
    const contract = stack();
    assert.ok(contract.validateProps?.({ sections: [] })[0]);
    assert.ok(
      contract
        .validateProps?.({ sections: [{ component: 'Nope', props: {} }] })
        .some((p) => p.includes('unknown component "Nope"')),
    );
    assert.ok(
      contract
        .validateProps?.({ sections: [{ component: SECTION_STACK_NAME, props: {} }] })
        .some((p) => p.includes('cannot nest')),
    );
    assert.ok(
      contract
        .validateProps?.({ sections: [{ component: 'Table', props: {} }] })
        .some((p) => p.includes('Table')),
    );
  });

  it('rejects two sections that publish the same pointer (state-key collision)', () => {
    const contract = stack();
    const grid = { component: 'OptionGrid', props: validOptionGridProps() };
    const problems = contract.validateProps?.({ sections: [grid, grid] }) ?? [];
    assert.ok(problems.some((p) => p.includes('already written by')));
  });

  it('allows two non-publishing sections of the same kind (two Tables)', () => {
    const contract = stack();
    const table = { component: 'Table', props: validTableProps() };
    assert.deepStrictEqual(contract.validateProps?.({ sections: [table, table] }), []);
  });

  it('allows a section contract that omits publishes and actions', () => {
    const contract = stack();
    const prose = { component: 'ProseFixture', props: { title: 'Read only' } };
    assert.deepStrictEqual(contract.validateProps?.({ sections: [prose] }), []);
    assert.strictEqual(contract.pendingAction?.({ sections: [prose] }), null);
  });

  it('composes sections into a Column-rooted adjacency list with identity-bearing ids', () => {
    const contract = stack();
    const nodes = contract.compose?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'Hi' } },
        { component: 'Table', props: validTableProps() },
      ],
    });
    assert.deepStrictEqual(nodes?.[0], {
      id: 'root',
      component: 'Column',
      children: ['ProseFixture-0', 'Table-0'],
    });
    assert.strictEqual(nodes?.[1]?.component, 'ProseFixture');
    assert.strictEqual(nodes?.[1]?.id, 'ProseFixture-0');
    assert.strictEqual(nodes?.[2]?.component, 'Table');
    assert.strictEqual(nodes?.[2]?.id, 'Table-0');
  });

  it('REGRESSION: a Table keeps its id when a section is inserted above it', () => {
    const withoutProse = stack().compose?.({
      sections: [{ component: 'Table', props: validTableProps() }],
    });
    const withProse = stack().compose?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'An answer' } },
        { component: 'Table', props: validTableProps() },
      ],
    });
    assert.strictEqual(
      withProse?.[2]?.id,
      withoutProse?.[1]?.id,
      'inserting above must not renumber the section below — that remounts it and wipes input',
    );
  });

  it('sections cannot override id/component via props', () => {
    const nodes = stack().compose?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'x', id: 'HACK', component: 'Evil' } },
      ],
    });
    assert.strictEqual(nodes?.[1]?.id, 'ProseFixture-0');
    assert.strictEqual(nodes?.[1]?.component, 'ProseFixture');
  });

  it('fallback delegates to sub-contract templates joined by ---', () => {
    const fallback = stack().fallbackTemplate?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'Hello' } },
        { component: 'Table', props: validTableProps() },
      ],
    });
    assert.ok(fallback?.includes('## Hello'));
    assert.ok(fallback?.includes('\n\n---\n\n'));
    assert.ok(fallback?.includes('| Service | Price |'));
  });

  it('wire integration: buildSurfaceEvents output reduces and walks into the tree', () => {
    const contract = stack();
    const built = buildSurfaceEvents({
      surfaceId: 'page-1',
      contract,
      catalogId: 'agentplace:builtin-v1',
      props: {
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: validTableProps() },
          { component: 'Table', props: validTableProps() },
        ],
      },
    });
    assert.strictEqual(built.ok, true);
    if (!built.ok) {
      return;
    }
    const surfaces = new Map<string, ReducedSurface>();
    for (const event of built.events) {
      reduceSurfaceEvent(surfaces, event.name, event.value);
    }
    const surface = surfaces.get('page-1');
    assert.ok(surface);
    const tree = resolveSurface(surface, {});
    assert.strictEqual(tree?.component, 'Column');
    assert.deepStrictEqual(
      tree?.children.map((child) => child.component),
      ['ProseFixture', 'Table', 'Table'],
    );
    assert.deepStrictEqual(tree?.danglingChildIds, []);
  });

  it('pendingAction finds an actionable child (not necessarily first)', () => {
    const result = stack().pendingAction?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'Hi' } },
        { component: 'Form', props: { fields: [{ id: 'a', label: 'A', kind: 'text' }] } },
      ],
    });
    assert.deepStrictEqual(result, { component: 'Form', label: 'form' });
  });

  it('pendingAction null for display-only stacks', () => {
    assert.strictEqual(
      stack().pendingAction?.({ sections: [{ component: 'Table', props: validTableProps() }] }),
      null,
    );
  });
});

describe('createSectionStackContract — composePartial (progressive streaming)', () => {
  it('an empty or not-yet-started sections array yields only the root, no pending child', () => {
    const result = stack().composePartial?.({ sections: [] });
    assert.deepStrictEqual(result?.nodes, [{ id: 'root', component: 'Column', children: [] }]);
  });

  it('a single fully-written section is NOT emitted while it is still the last element', () => {
    const result = stack().composePartial?.({
      sections: [{ component: 'ProseFixture', props: { title: 'Hi' } }],
    });
    assert.deepStrictEqual(result?.nodes, [{ id: 'root', component: 'Column', children: [] }]);
  });

  it('a section is emitted once a later element has started in the parsed array', () => {
    const result = stack().composePartial?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'Hi' } },
        { component: 'Table', props: validTableProps() },
      ],
    });
    assert.deepStrictEqual(result?.nodes[0], {
      id: 'root',
      component: 'Column',
      children: ['ProseFixture-0'],
    });
    assert.strictEqual(
      result?.nodes.length,
      2,
      'only the first section is complete — the one still being written stays a dangling id',
    );
    assert.strictEqual(result?.nodes[1]?.id, 'ProseFixture-0');
    assert.strictEqual(result?.nodes[1]?.component, 'ProseFixture');
  });

  it('a section with no component yet blocks completeness even if a later element started', () => {
    const result = stack().composePartial?.({
      sections: [
        { component: '', props: {} },
        { component: 'Table', props: validTableProps() },
      ],
    });
    assert.deepStrictEqual(result?.nodes, [{ id: 'root', component: 'Column', children: [] }]);
  });

  it('multiple complete sections accumulate in order', () => {
    const result = stack().composePartial?.({
      sections: [
        { component: 'ProseFixture', props: { title: 'A' } },
        { component: 'Table', props: validTableProps() },
        { component: 'ProseFixture', props: { title: 'still writing' } },
      ],
    });
    assert.deepStrictEqual(
      result?.nodes.map((n) => n.id),
      ['root', 'ProseFixture-0', 'Table-0'],
    );
  });
});

describe('sectionNodeId — identity, not position', () => {
  const form = (fieldIds: string[]) => ({
    component: 'Form',
    props: { fields: fieldIds.map((id) => ({ id, label: id, kind: 'text' })) },
  });

  it('is stable when only content changes', () => {
    const before = sectionNodeId(form(['name', 'date']), 0, ['Form']);
    const relabelled = {
      component: 'Form',
      props: {
        fields: [
          { id: 'name', label: 'Your full name', kind: 'text' },
          { id: 'date', label: 'Preferred date', kind: 'text' },
        ],
      },
    };
    assert.strictEqual(sectionNodeId(relabelled, 0, ['Form']), before);
  });

  it('is stable when the section moves position', () => {
    const at0 = sectionNodeId(form(['name']), 0, ['Form']);
    const at3 = sectionNodeId(form(['name']), 3, ['TextBlock', 'TextBlock', 'TextBlock', 'Form']);
    assert.strictEqual(at3, at0);
  });

  it('DIFFERS for a different form — no cross-form DOM reuse', () => {
    assert.notStrictEqual(
      sectionNodeId(form(['name', 'date']), 0, ['Form']),
      sectionNodeId(form(['email', 'message']), 0, ['Form']),
    );
  });

  it('falls back to a type-scoped ordinal with no identity key', () => {
    const text = (markdown: string) => ({ component: 'TextBlock', props: { markdown } });
    assert.strictEqual(sectionNodeId(text('hello'), 0, ['TextBlock']), 'TextBlock-0');
    assert.strictEqual(sectionNodeId(text('second'), 1, ['TextBlock', 'TextBlock']), 'TextBlock-1');
  });

  it('scopes the ordinal by component, so an inserted TextBlock does not renumber a Table', () => {
    const table = { component: 'Table', props: { rows: [] } };
    const before = sectionNodeId(table, 0, ['Table']);
    const after = sectionNodeId(table, 1, ['TextBlock', 'Table']);
    assert.strictEqual(after, before, 'the Table is still the first Table');
  });
});
