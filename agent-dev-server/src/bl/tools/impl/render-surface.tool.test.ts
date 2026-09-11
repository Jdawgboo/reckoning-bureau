import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { parse } from 'best-effort-json-parser';
import { SurfaceTool, createSurfaceTools } from './render-surface.tool.ts';
import {
  Agent,
  ToolRegistry,
  type AgentRunner,
  type AgentRunnerHandle,
  type AgentRunnerRunOptions,
  type AgentStreamEvent,
  type AguiEvent,
  type ToolExecuteContext,
} from '../../agent/agent-library.ts';
import type { ComponentContract } from '../../../../vendor/agentplace-a2ui/contract-schema.ts';
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';
import { createSectionStackContract } from '../../builtin-catalog/section-stack.ts';
import {
  reduceSurfaceEvent,
  type ReducedSurface,
} from '../../../../vendor/agentplace-a2ui/surface-reduction.ts';
import { resolveSurface } from '../../../../vendor/agentplace-a2ui/walker.ts';
import { isRecord } from '../../../util/type-guards.ts';
import type { ToolModel } from '../../agent/agent-library.ts';
import { snapshotSurface } from '../../../ws/surface-carry-forward.ts';
import { scriptedModel } from '../../../../vendor/agent-library/test-utils/scripted-model.ts';

const CARD_FIXTURE: ComponentContract = {
  component: 'Card',
  purpose: 'Fixture card screen.',
  props: {
    question: { type: 'string', required: true, description: 'Question' },
  },
  publishes: {},
  actions: {
    submit: { context: {} },
  },
};

const TABLE_FIXTURE: ComponentContract = {
  component: 'Table',
  purpose: 'Fixture display-only screen.',
  props: {
    title: { type: 'string', required: true, description: 'Title' },
  },
  publishes: {},
  actions: {},
};

interface EmittedCustomEvent {
  name: string;
  value: unknown;
}

function makeCtx(): ToolExecuteContext & { emittedCustomEvents: EmittedCustomEvent[] } {
  const emittedCustomEvents: EmittedCustomEvent[] = [];
  return {
    runner: { state: undefined },
    toolCallId: 'test-1',
    emitCustomEvent: (name, value) => {
      emittedCustomEvents.push({ name, value });
    },
    emittedCustomEvents,
  };
}

describe('SurfaceTool.execute uiProps', () => {
  it('carries pendingAction when present, and drops a stray voiceSummary arg', async () => {
    const tool = new SurfaceTool({ contract: CARD_FIXTURE, catalogId: 'fixture:card-v1' });
    const ctx = makeCtx();
    const result = await tool.execute(
      {
        surfaceId: 'card-1',
        question: 'Ready to book?',
        fallbackMarkdown: 'Ready to book?',
        voiceSummary: 'A stale caller may still send this; it must go nowhere.',
      },
      ctx,
    );
    assert.deepStrictEqual(result.uiProps, {
      surfaceId: 'card-1',
      component: 'Card',
      surfaceReplay: ctx.emittedCustomEvents,
      pendingAction: { component: 'Card', label: 'card' },
    });
  });

  it('omits pendingAction when it does not apply', async () => {
    const tool = new SurfaceTool({ contract: TABLE_FIXTURE, catalogId: 'fixture:table-v1' });
    const ctx = makeCtx();
    const result = await tool.execute(
      {
        surfaceId: 'table-1',
        title: 'Menu',
        fallbackMarkdown: 'Menu',
      },
      ctx,
    );
    assert.deepStrictEqual(result.uiProps, {
      surfaceId: 'table-1',
      component: 'Table',
      surfaceReplay: ctx.emittedCustomEvents,
    });
  });

  it('persists the composed A2UI events in uiProps for session restore', async () => {
    const tool = new SurfaceTool({ contract: CARD_FIXTURE, catalogId: 'fixture:card-v1' });
    const ctx = makeCtx();
    const result = await tool.execute(
      {
        surfaceId: 'card-2',
        question: 'Ready to check out?',
        fallbackMarkdown: 'Ready to check out?',
      },
      ctx,
    );
    assert.deepStrictEqual(result.uiProps?.surfaceReplay, ctx.emittedCustomEvents);
  });
});

const PROSE_FIXTURE: ComponentContract = {
  component: 'ProseFixture',
  purpose: 'Prose fixture.',
  props: { title: { type: 'string', description: 'Title' } },
  publishes: {},
  actions: {},
};

const SIGNUP_FIXTURE: ComponentContract = {
  component: 'SignupFixture',
  purpose: 'Signup fixture.',
  props: {
    fields: { type: 'array', required: true, items: {}, description: 'Fields' },
  },
  publishes: { '/signup/{id}': { valueType: 'string' } },
  actions: { submit: { context: {} } },
};

function stackContract(): ComponentContract {
  return createSectionStackContract({
    ProseFixture: PROSE_FIXTURE,
    Table: TABLE_FIXTURE,
    SignupFixture: SIGNUP_FIXTURE,
  });
}

function collectEmits(): {
  emit: (name: string, value: unknown) => void;
  emitted: Array<{ name: string; value: unknown }>;
} {
  const emitted: Array<{ name: string; value: unknown }> = [];
  return { emit: (name, value) => emitted.push({ name, value }), emitted };
}

/**
 * The producer-side reality: providers emit tool input a few characters at a
 * time, so `surfaceId` is visible as a growing prefix long before it is final.
 * Mirrors `AgentService.maybeStreamPartialInput`, which best-effort-parses the
 * accumulated buffer on every delta.
 */
function streamCharacterDeltas(
  tool: SurfaceTool,
  json: string,
  emit: (name: string, value: unknown) => void,
  toolCallId: string,
  step = 4,
): void {
  for (let cut = step; cut <= json.length; cut += step) {
    tool.streamPartialInput(parse(json.slice(0, cut)), emit, { toolCallId });
  }
  tool.streamPartialInput(parse(json), emit, { toolCallId });
}

function emittedSurfaceIds(emitted: Array<{ name: string; value: unknown }>): string[] {
  const ids = new Set<string>();
  for (const event of emitted) {
    if (isRecord(event.value) && typeof event.value.surfaceId === 'string') {
      ids.add(event.value.surfaceId);
    }
  }
  return [...ids];
}

describe('SurfaceTool.wantsPartialInput', () => {
  it('opts out of per-delta parsing when the contract has no progressive composition', () => {
    const plain = new SurfaceTool({ contract: CARD_FIXTURE, catalogId: 'fixture:card-v1' });
    assert.strictEqual(plain.wantsPartialInput, false);
  });

  it('opts in when the contract composes partial input', () => {
    const stack = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    assert.strictEqual(stack.wantsPartialInput, true);
  });
});

describe('SurfaceTool.streamPartialInput — character-level deltas', () => {
  it('never latches a truncated surfaceId, and still streams sections', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();
    const json = JSON.stringify({
      surfaceId: 'menu-board-1',
      sections: [
        { component: 'ProseFixture', props: { title: 'Starters' } },
        { component: 'Table', props: { title: 'Mains' } },
        { component: 'ProseFixture', props: { title: 'Desserts' } },
      ],
    });

    streamCharacterDeltas(tool, json, emit, 'call-chars');

    assert.deepStrictEqual(
      emittedSurfaceIds(emitted),
      ['menu-board-1'],
      'every emission must target the settled surfaceId, never a prefix of it',
    );
    const withSections = emitted.filter(
      (event) =>
        event.name.endsWith('updateComponents') &&
        isRecord(event.value) &&
        Array.isArray(event.value.components) &&
        event.value.components.length > 1,
    );
    assert.ok(
      withSections.length > 0,
      `at least one section must reach the screen, got ${JSON.stringify(emitted)}`,
    );
  });
});

describe('SurfaceTool.streamPartialInput — SectionStack progressive rendering', () => {
  it('emits createSurface exactly once, then sections one at a time as they complete', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-1';

    tool.streamPartialInput({ surfaceId: 'stack-1', sections: [] }, emit, { toolCallId });
    assert.strictEqual(emitted.filter((e) => e.name.endsWith('createSurface')).length, 1);
    assert.strictEqual(emitted.length, 2, 'createSurface + initial frame updateComponents');
    const framePayload = emitted[1]?.value as { components: Array<{ id: string }> };
    assert.deepStrictEqual(
      framePayload.components.map((c) => c.id),
      ['root'],
    );

    tool.streamPartialInput(
      { surfaceId: 'stack-1', sections: [{ component: 'ProseFixture', props: { title: 'Hi' } }] },
      emit,
      { toolCallId },
    );
    assert.strictEqual(emitted.length, 2, 'a single not-yet-followed section emits nothing new');

    tool.streamPartialInput(
      {
        surfaceId: 'stack-1',
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: { title: 'still writing' } },
        ],
      },
      emit,
      { toolCallId },
    );
    assert.strictEqual(emitted.length, 3, 's0 becomes complete once s1 has started');
    assert.strictEqual(emitted.filter((e) => e.name.endsWith('createSurface')).length, 1);
    const secondUpdate = emitted[2]?.value as {
      components: Array<{ id: string; component: string; children?: string[] }>;
    };
    assert.deepStrictEqual(
      secondUpdate.components.map((c) => c.id),
      ['root', 'ProseFixture-0'],
      'the still-writing section is never emitted as a node',
    );
    assert.deepStrictEqual(secondUpdate.components[0]?.children, ['ProseFixture-0']);
    assert.strictEqual(secondUpdate.components[1]?.component, 'ProseFixture');
  });

  it('decodes stray \\uXXXX escapes in streamed section text', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput(
      {
        surfaceId: 'stack-esc',
        sections: [
          { component: 'ProseFixture', props: { title: 'from \\u00a3220 a week' } },
          { component: 'Table', props: { title: 'still writing' } },
        ],
      },
      emit,
      { toolCallId: 'call-esc' },
    );

    const update = emitted.at(-1)?.value as {
      components: Array<Record<string, unknown>>;
    };
    const prose = update.components.find((c) => c['component'] === 'ProseFixture');
    assert.strictEqual(prose?.['title'], 'from £220 a week');
  });

  it('a half-written section is absent from the tree entirely — through the real walker', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput(
      {
        surfaceId: 'stack-2',
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: {} },
        ],
      },
      emit,
      { toolCallId: 'call-2' },
    );

    const surfaces = new Map<string, ReducedSurface>();
    for (const event of emitted) {
      reduceSurfaceEvent(surfaces, event.name, event.value);
    }
    const tree = resolveSurface(surfaces.get('stack-2'), {});
    assert.strictEqual(tree?.component, 'Column');
    assert.deepStrictEqual(
      tree?.children.map((c) => c.component),
      ['ProseFixture'],
      'only the complete section resolves to a real node',
    );
    assert.deepStrictEqual(
      tree?.danglingChildIds,
      [],
      'the still-writing section is omitted, not referenced as an unresolved child',
    );
  });

  it('a stack whose call never completes still gets the correct atomic render from execute()', async () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit } = collectEmits();
    const toolCallId = 'call-3';

    tool.streamPartialInput(
      {
        surfaceId: 'stack-3',
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: { title: 'abandoned partial' } },
        ],
      },
      emit,
      { toolCallId },
    );

    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;
    const result = await tool.execute(
      {
        surfaceId: 'stack-3',
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: { title: 'final' } },
        ],
        fallbackMarkdown: 'fb',
      },
      ctx,
    );

    const surfaces = new Map<string, ReducedSurface>();
    for (const event of ctx.emittedCustomEvents) {
      reduceSurfaceEvent(surfaces, event.name, event.value);
    }
    const tree = resolveSurface(surfaces.get('stack-3'), {});
    assert.strictEqual(typeof result.output, 'string');
    assert.ok(typeof result.output === 'string' && result.output.includes('stack-3'));
    assert.deepStrictEqual(
      tree?.children.map((c) => c.component),
      ['ProseFixture', 'Table'],
      'execute() is authoritative and renders both sections regardless of the abandoned partial pass',
    );
    assert.deepStrictEqual(tree?.danglingChildIds, []);
  });

  it('a non-SectionStack (single-component) contract streams no progressive UI', () => {
    const tool = new SurfaceTool({ contract: CARD_FIXTURE, catalogId: 'fixture:card-v1' });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput({ surfaceId: 'card-9', question: 'still typing' }, emit, {
      toolCallId: 'call-4',
    });

    assert.strictEqual(
      emitted.length,
      0,
      'no composePartial hook on this contract — no-op by design',
    );
  });

  it('re-emits when node content changes even though the node count does not', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-content-dedupe';

    // Two sections; the second's presence settles the first.
    tool.streamPartialInput(
      {
        surfaceId: 's1',
        sections: [
          { component: 'ProseFixture', props: { title: 'Old' } },
          { component: 'ProseFixture', props: {} },
        ],
      },
      emit,
      { toolCallId },
    );
    // Same section COUNT, but the settled first section's content changed.
    tool.streamPartialInput(
      {
        surfaceId: 's1',
        sections: [
          { component: 'ProseFixture', props: { title: 'New' } },
          { component: 'ProseFixture', props: {} },
        ],
      },
      emit,
      { toolCallId },
    );

    const updates = emitted.filter((e) => e.name.endsWith('updateComponents'));
    const serialized = JSON.stringify(updates.at(-1)?.value ?? {});
    assert.ok(updates.length >= 2, `expected a second emission, got ${updates.length}`);
    assert.ok(serialized.includes('New'), 'latest emission must carry the changed content');
  });

  it('stays silent when a delta changes nothing settled', () => {
    const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-noop-dedupe';
    const partial = {
      surfaceId: 's2',
      sections: [
        { component: 'ProseFixture', props: { title: 'A' } },
        { component: 'ProseFixture', props: {} },
      ],
    };
    tool.streamPartialInput(partial, emit, { toolCallId });
    const before = emitted.length;
    tool.streamPartialInput(structuredClone(partial), emit, { toolCallId });
    assert.strictEqual(emitted.length, before, 'identical settled content must not re-emit');
  });
});

describe('SurfaceTool — no voiceSummary param', () => {
  /** `getDefinition().parameters` is the AI SDK `jsonSchema()` wrapper — the
   *  raw schema hangs off `.jsonSchema`. */
  function schemaOf(tool: ToolModel): Record<string, unknown> {
    const wrapper: unknown = tool.getDefinition().parameters;
    if (!isRecord(wrapper)) {
      return {};
    }
    const raw = wrapper['jsonSchema'];
    return isRecord(raw) ? raw : {};
  }

  it('never offers or requires voiceSummary — rejected by the fact-driven voice design', () => {
    const tool = new SurfaceTool({ contract: CARD_FIXTURE, catalogId: 'fixture:card-v1' });
    const raw = schemaOf(tool);
    const properties = raw['properties'];
    assert.ok(isRecord(properties));
    assert.strictEqual('voiceSummary' in properties, false);
    const required = raw['required'];
    assert.ok(Array.isArray(required));
    assert.strictEqual(required.includes('voiceSummary'), false);
  });
});

describe('SurfaceTool.streamPartialInput — never demolishes a screen already up', () => {
  it('skips progressive rendering when the surface already has content', () => {
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      // The visitor is already looking at this screen.
      getSurfaceSnapshot: () => ({
        isPopulated: true,
        sections: [{ component: 'ProseFixture', props: { title: 'Already here' } }],
      }),
    });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput(
      {
        surfaceId: 'stack-live',
        sections: [
          { component: 'ProseFixture', props: { title: 'Hi' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      emit,
      { toolCallId: 'call-live' },
    );

    assert.strictEqual(
      emitted.length,
      0,
      'progressive rendering strips the screen to a skeleton first — fine for a new screen, a full-page refresh for one being re-rendered',
    );
  });

  it('still streams progressively for a screen being built from nothing', () => {
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: () => ({ isPopulated: false, sections: [] }),
    });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput({ surfaceId: 'stack-new', sections: [] }, emit, {
      toolCallId: 'call-new',
    });
    assert.ok(emitted.length > 0);
  });

  it('treats a populated single-component root as occupied even without stack sections', () => {
    const surfaces = new Map<string, ReducedSurface>();
    surfaces.set('screen', {
      surfaceId: 'screen',
      catalogId: 'fixture:prose-v1',
      components: new Map([
        ['root', { id: 'root', component: 'ProseFixture', title: 'Already here' }],
      ]),
    });
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: (surfaceId) => snapshotSurface(surfaces.get(surfaceId)),
    });
    const { emit, emitted } = collectEmits();

    tool.streamPartialInput(
      {
        surfaceId: 'screen',
        sections: [
          { component: 'ProseFixture', props: { title: 'New' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      emit,
      { toolCallId: 'call-single-root' },
    );

    assert.deepStrictEqual(snapshotSurface(surfaces.get('screen')), {
      isPopulated: true,
      sections: [],
    });
    assert.deepStrictEqual(emitted, []);
    assert.strictEqual(surfaces.get('screen')?.components.get('root')?.component, 'ProseFixture');
  });

  it('uses one pre-call snapshot instead of suppressing its own later sections', () => {
    const surfaces = new Map<string, ReducedSurface>();
    let snapshotCount = 0;
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: (surfaceId) => {
        snapshotCount++;
        return snapshotSurface(surfaces.get(surfaceId));
      },
    });
    const emit = (name: string, value: unknown) => {
      reduceSurfaceEvent(surfaces, name, value);
    };
    const toolCallId = 'call-feedback';

    tool.streamPartialInput(
      {
        surfaceId: 'growing',
        sections: [
          { component: 'ProseFixture', props: { title: 'A' } },
          { component: 'Table', props: { title: 'B writing' } },
        ],
      },
      emit,
      { toolCallId },
    );
    assert.deepStrictEqual(
      resolveSurface(surfaces.get('growing'), {})?.children.map((child) => child.component),
      ['ProseFixture'],
    );

    tool.streamPartialInput(
      {
        surfaceId: 'growing',
        sections: [
          { component: 'ProseFixture', props: { title: 'A' } },
          { component: 'Table', props: { title: 'B' } },
          { component: 'ProseFixture', props: { title: 'C writing' } },
        ],
      },
      emit,
      { toolCallId },
    );

    assert.deepStrictEqual(
      resolveSurface(surfaces.get('growing'), {})?.children.map((child) => child.component),
      ['ProseFixture', 'Table'],
    );
    assert.strictEqual(snapshotCount, 1);
  });

  it('carries forward only the sections captured before progressive output', async () => {
    const surfaces = new Map<string, ReducedSurface>();
    surfaces.set('screen', {
      surfaceId: 'screen',
      catalogId: 'fixture:stack-v1',
      components: new Map([
        ['root', { id: 'root', component: 'Column', children: ['SignupFixture-email'] }],
        [
          'SignupFixture-email',
          {
            id: 'SignupFixture-email',
            component: 'SignupFixture',
            fields: [{ id: 'email', label: 'Original' }],
          },
        ],
      ]),
    });
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: (surfaceId) => snapshotSurface(surfaces.get(surfaceId)),
      catalogContracts: {
        ProseFixture: PROSE_FIXTURE,
        Table: TABLE_FIXTURE,
        SignupFixture: SIGNUP_FIXTURE,
      },
    });
    const toolCallId = 'call-stable-carry';

    tool.streamPartialInput(
      {
        surfaceId: 'screen',
        sections: [
          { component: 'ProseFixture', props: { title: 'Answer' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      () => assert.fail('a populated surface must not emit progressive events'),
      { toolCallId },
    );
    surfaces.set('screen', {
      surfaceId: 'screen',
      catalogId: 'fixture:stack-v1',
      components: new Map([
        ['root', { id: 'root', component: 'Column', children: ['SignupFixture-phone'] }],
        [
          'SignupFixture-phone',
          {
            id: 'SignupFixture-phone',
            component: 'SignupFixture',
            fields: [{ id: 'phone', label: 'Later mutation' }],
          },
        ],
      ]),
    });
    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;

    await tool.execute(
      {
        surfaceId: 'screen',
        sections: [{ component: 'ProseFixture', props: { title: 'Answer' } }],
        fallbackMarkdown: 'Answer',
      },
      ctx,
    );

    const resultSurfaces = new Map<string, ReducedSurface>();
    for (const event of ctx.emittedCustomEvents) {
      reduceSurfaceEvent(resultSurfaces, event.name, event.value);
    }
    const signup = resolveSurface(resultSurfaces.get('screen'), {})?.children.find(
      (child) => child.component === 'SignupFixture',
    );
    assert.deepStrictEqual(signup?.props.fields, [{ id: 'email', label: 'Original' }]);
  });

  it('captures one snapshot at execute when no partial hook ran', async () => {
    let snapshotCount = 0;
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: () => {
        snapshotCount++;
        return { isPopulated: false, sections: [] };
      },
    });

    await tool.execute(
      {
        surfaceId: 'atomic-only',
        sections: [{ component: 'ProseFixture', props: { title: 'Answer' } }],
        fallbackMarkdown: 'Answer',
      },
      makeCtx(),
    );

    assert.strictEqual(snapshotCount, 1);
  });

  it('does not reuse a provisional surface snapshot for a changed final id', async () => {
    const snapshotIds: string[] = [];
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: (surfaceId) => {
        snapshotIds.push(surfaceId);
        return { isPopulated: false, sections: [] };
      },
    });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-id-change';
    const partialSections = [
      { component: 'ProseFixture', props: { title: 'A' } },
      { component: 'Table', props: { title: 'B writing' } },
    ];

    tool.streamPartialInput({ surfaceId: 'provisional', sections: partialSections }, emit, {
      toolCallId,
    });
    const provisionalEventCount = emitted.length;
    tool.streamPartialInput({ surfaceId: 'final', sections: partialSections }, emit, {
      toolCallId,
    });
    assert.strictEqual(emitted.length, provisionalEventCount);

    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;
    await tool.execute(
      {
        surfaceId: 'final',
        sections: [{ component: 'ProseFixture', props: { title: 'Final' } }],
        fallbackMarkdown: 'Final',
      },
      ctx,
    );

    assert.deepStrictEqual(snapshotIds, ['provisional', 'final']);
    assert.deepStrictEqual(ctx.emittedCustomEvents[0], {
      name: A2UI_EVENT_NAMES.deleteSurface,
      value: { surfaceId: 'provisional' },
    });
    assert.ok(
      ctx.emittedCustomEvents
        .slice(1)
        .every((event) => isRecord(event.value) && event.value['surfaceId'] === 'final'),
    );
  });

  it('removes a new progressive surface when final validation fails', async () => {
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: () => ({ isPopulated: false, sections: [] }),
    });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-invalid-new';
    tool.streamPartialInput(
      {
        surfaceId: 'broken',
        sections: [
          { component: 'ProseFixture', props: { title: 'Visible too early' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      emit,
      { toolCallId },
    );
    assert.ok(emitted.some((event) => event.name === A2UI_EVENT_NAMES.updateComponents));
    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;

    const result = await tool.execute(
      { surfaceId: 'broken', sections: [], fallbackMarkdown: '' },
      ctx,
    );

    assert.match(String(result.output), /Cannot render SectionStack/);
    assert.deepStrictEqual(ctx.emittedCustomEvents, [
      { name: A2UI_EVENT_NAMES.deleteSurface, value: { surfaceId: 'broken' } },
    ]);
  });

  it('removes a new progressive surface when contract validation throws', async () => {
    const contract = stackContract();
    contract.validateProps = () => {
      throw new Error('validation exploded');
    };
    const tool = new SurfaceTool({
      contract,
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: () => ({ isPopulated: false, sections: [] }),
    });
    const { emit } = collectEmits();
    const toolCallId = 'call-throw-new';
    tool.streamPartialInput(
      {
        surfaceId: 'throwing',
        sections: [
          { component: 'ProseFixture', props: { title: 'Visible too early' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      emit,
      { toolCallId },
    );
    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;

    await assert.rejects(
      tool.execute(
        {
          surfaceId: 'throwing',
          sections: [{ component: 'ProseFixture', props: { title: 'Final' } }],
          fallbackMarkdown: '',
        },
        ctx,
      ),
      /validation exploded/,
    );
    assert.deepStrictEqual(ctx.emittedCustomEvents, [
      { name: A2UI_EVENT_NAMES.deleteSurface, value: { surfaceId: 'throwing' } },
    ]);
  });

  it('leaves a populated screen untouched when final validation fails', async () => {
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: () => ({ isPopulated: true, sections: [] }),
    });
    const { emit, emitted } = collectEmits();
    const toolCallId = 'call-invalid-final';
    tool.streamPartialInput(
      {
        surfaceId: 'screen',
        sections: [
          { component: 'ProseFixture', props: { title: 'New' } },
          { component: 'Table', props: { title: 'writing' } },
        ],
      },
      emit,
      { toolCallId },
    );
    const ctx = makeCtx();
    ctx.toolCallId = toolCallId;

    const result = await tool.execute(
      { surfaceId: 'screen', sections: [], fallbackMarkdown: '' },
      ctx,
    );

    assert.deepStrictEqual(emitted, []);
    assert.deepStrictEqual(ctx.emittedCustomEvents, []);
    assert.match(String(result.output), /sections must be a non-empty array/);
  });
});

describe('SurfaceTool.execute — surface.rendered log', () => {
  it('reports why streaming did not happen', async () => {
    const lines: string[] = [];
    const restore = mock.method(console, 'log', (line: string) => void lines.push(String(line)));
    try {
      const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
      const ctx = makeCtx();
      await tool.execute(
        { surfaceId: 'quiet-1', sections: [{ component: 'ProseFixture', props: { title: 'T' } }] },
        ctx,
      );
      const rendered = lines.find((line) => line.includes('surface.rendered'));
      assert.ok(rendered, 'surface.rendered must be logged');
      assert.ok(rendered.includes('"progressive":"skipped:no-ticks"'), rendered);
      assert.ok(rendered.includes('"toolCallId":"test-1"'), rendered);
    } finally {
      restore.mock.restore();
    }
  });

  it('does not report streamed when only the empty frame went out', async () => {
    const lines: string[] = [];
    const restore = mock.method(console, 'log', (line: string) => void lines.push(String(line)));
    try {
      const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
      const { emit, emitted } = collectEmits();
      const toolCallId = 'call-frame-only';
      tool.streamPartialInput({ surfaceId: 'frame-1', sections: [] }, emit, { toolCallId });
      assert.ok(emitted.length > 0, 'the frame itself did go out');

      const ctx = makeCtx();
      ctx.toolCallId = toolCallId;
      await tool.execute(
        {
          surfaceId: 'frame-1',
          sections: [{ component: 'ProseFixture', props: { title: 'T' } }],
          fallbackMarkdown: 'T',
        },
        ctx,
      );

      const rendered = lines.find((line) => line.includes('surface.rendered'));
      assert.ok(rendered, 'surface.rendered must be logged');
      assert.ok(rendered.includes('"progressive":"skipped:frame-only"'), rendered);
    } finally {
      restore.mock.restore();
    }
  });

  it('reports streamed once a settled section reached the screen', async () => {
    const lines: string[] = [];
    const restore = mock.method(console, 'log', (line: string) => void lines.push(String(line)));
    try {
      const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
      const { emit } = collectEmits();
      const toolCallId = 'call-streamed';
      const sections = [
        { component: 'ProseFixture', props: { title: 'Starters' } },
        { component: 'Table', props: { title: 'Mains' } },
      ];
      streamCharacterDeltas(
        tool,
        JSON.stringify({ surfaceId: 'streamed-1', sections }),
        emit,
        toolCallId,
      );

      const ctx = makeCtx();
      ctx.toolCallId = toolCallId;
      await tool.execute({ surfaceId: 'streamed-1', sections, fallbackMarkdown: 'Menu' }, ctx);

      const rendered = lines.find((line) => line.includes('surface.rendered'));
      assert.ok(rendered, 'surface.rendered must be logged');
      assert.ok(rendered.includes('"progressive":"streamed"'), rendered);
    } finally {
      restore.mock.restore();
    }
  });

  it('does not report streamed for a final surfaceId that never itself streamed', async () => {
    const lines: string[] = [];
    const restore = mock.method(console, 'log', (line: string) => void lines.push(String(line)));
    try {
      const tool = new SurfaceTool({ contract: stackContract(), catalogId: 'fixture:stack-v1' });
      const { emit } = collectEmits();
      const toolCallId = 'call-mismatched-final';
      tool.streamPartialInput(
        {
          surfaceId: 'provisional-x',
          sections: [
            { component: 'ProseFixture', props: { title: 'A' } },
            { component: 'Table', props: { title: 'writing' } },
          ],
        },
        emit,
        { toolCallId },
      );
      const ctx = makeCtx();
      ctx.toolCallId = toolCallId;

      await tool.execute(
        {
          surfaceId: 'final-y',
          sections: [{ component: 'ProseFixture', props: { title: 'Final' } }],
          fallbackMarkdown: 'Final',
        },
        ctx,
      );

      const rendered = lines.find((line) => line.includes('"surfaceId":"final-y"'));
      assert.ok(rendered, 'surface.rendered for final-y must be logged');
      assert.ok(
        !rendered.includes('"progressive":"streamed"'),
        `final-y never streamed itself, but got: ${rendered}`,
      );
      assert.ok(rendered.includes('"progressive":"skipped:no-ticks"'), rendered);
      assert.ok(rendered.includes(`"toolCallId":"${toolCallId}"`), rendered);
    } finally {
      restore.mock.restore();
    }
  });
});

interface DeferredSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferredSignal(): DeferredSignal {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

class ControlledPartialRunner implements AgentRunner {
  readonly #toolName: string;
  readonly #chunks: readonly string[];
  readonly #releaseSecondChunk: Promise<void>;
  readonly #releaseFinalChunk: Promise<void>;

  constructor(params: {
    toolName: string;
    chunks: readonly string[];
    releaseSecondChunk: Promise<void>;
    releaseFinalChunk: Promise<void>;
  }) {
    this.#toolName = params.toolName;
    this.#chunks = params.chunks;
    this.#releaseSecondChunk = params.releaseSecondChunk;
    this.#releaseFinalChunk = params.releaseFinalChunk;
  }

  async runStream(_options: AgentRunnerRunOptions): Promise<AgentRunnerHandle> {
    const toolName = this.#toolName;
    const chunks = this.#chunks;
    const releaseSecondChunk = this.#releaseSecondChunk;
    const releaseFinalChunk = this.#releaseFinalChunk;
    const events = (async function* (): AsyncGenerator<AgentStreamEvent> {
      yield { type: 'model-step-start', stepIndex: 0 };
      yield { type: 'tool-input-start', toolCallId: 'controlled-call', toolName };
      yield { type: 'tool-input-delta', toolCallId: 'controlled-call', delta: chunks[0] ?? '' };
      await releaseSecondChunk;
      yield { type: 'tool-input-delta', toolCallId: 'controlled-call', delta: chunks[1] ?? '' };
      await releaseFinalChunk;
      yield { type: 'tool-input-delta', toolCallId: 'controlled-call', delta: chunks[2] ?? '' };
      yield { type: 'tool-input-end', toolCallId: 'controlled-call' };
      yield { type: 'model-step-end', stepIndex: 0, finishReason: 'stop' };
      yield { type: 'finish', finishReason: 'stop' };
    })();
    return { events, done: Promise.resolve({}) };
  }
}

function controlledPartialChunks(): string[] {
  const input = {
    surfaceId: 'controlled-stack',
    sections: [
      { component: 'ProseFixture', props: { title: `A${'a'.repeat(320)}` } },
      { component: 'Table', props: { title: `B${'b'.repeat(320)}` } },
      { component: 'ProseFixture', props: { title: `C${'c'.repeat(320)}` } },
    ],
  };
  const full = JSON.stringify(input);
  const secondSection = full.indexOf('Bbbbb');
  const thirdSection = full.indexOf('Ccccc');
  assert.ok(secondSection > 0 && thirdSection > secondSection);
  const firstBoundary = secondSection + 170;
  const secondBoundary = thirdSection + 170;
  const chunks = [
    full.slice(0, firstBoundary),
    full.slice(firstBoundary, secondBoundary),
    full.slice(secondBoundary),
  ];
  for (const chunk of chunks) {
    assert.ok(chunk.length >= 150, 'every controlled delta must cross the parse threshold');
  }
  return chunks;
}

function isCustomEvent(event: AguiEvent): event is AguiEvent & {
  type: 'CUSTOM';
  name: string;
  value: unknown;
} {
  return event.type === 'CUSTOM';
}

describe('SurfaceTool progressive rendering — AgentService integration', () => {
  it('keeps emitting later sections after the first progressive event reaches session state', {
    timeout: 5_000,
  }, async () => {
    const surfaces = new Map<string, ReducedSurface>();
    let snapshotCount = 0;
    const tool = new SurfaceTool({
      contract: stackContract(),
      catalogId: 'fixture:stack-v1',
      getSurfaceSnapshot: (surfaceId) => {
        snapshotCount++;
        return snapshotSurface(surfaces.get(surfaceId));
      },
    });
    const firstSectionPresented = deferredSignal();
    const secondSectionPresented = deferredSignal();
    const chunks = controlledPartialChunks();
    const agent = new Agent({
      model: scriptedModel([]),
      runner: new ControlledPartialRunner({
        toolName: tool.getName(),
        chunks,
        releaseSecondChunk: firstSectionPresented.promise,
        releaseFinalChunk: secondSectionPresented.promise,
      }),
      systemInstruction: 'Controlled progressive surface integration fixture.',
      toolRegistry: new ToolRegistry([tool]),
    });

    const handle = await agent.runHandle({ query: 'render the fixture' });
    for await (const event of handle.agui) {
      if (!isCustomEvent(event)) {
        continue;
      }
      reduceSurfaceEvent(surfaces, event.name, event.value);
      const childCount = resolveSurface(surfaces.get('controlled-stack'), {})?.children.length ?? 0;
      if (childCount >= 1) {
        firstSectionPresented.resolve();
      }
      if (childCount >= 2) {
        secondSectionPresented.resolve();
      }
    }
    const outcome = await handle.done;

    assert.strictEqual(outcome.status, 'ok');
    assert.deepStrictEqual(
      resolveSurface(surfaces.get('controlled-stack'), {})?.children.map(
        (child) => child.component,
      ),
      ['ProseFixture', 'Table'],
    );
    assert.strictEqual(snapshotCount, 1);
  });
});
