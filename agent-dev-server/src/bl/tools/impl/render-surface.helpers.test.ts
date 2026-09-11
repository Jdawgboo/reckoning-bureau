import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSurfaceEvents,
  mergeSeedIntoUiState,
  splitToolInput,
} from './render-surface.helpers.ts';
import type { ComponentContract } from '../../../../vendor/agentplace-a2ui/contract-schema.ts';
import { createSectionStackContract } from '../../builtin-catalog/section-stack.ts';

/** Fixture contracts — the helpers are contract-agnostic platform code and
 *  must not depend on the agent zone. */
const CATALOG_FIXTURE: ComponentContract = {
  component: 'Catalog',
  purpose: 'Fixture list screen.',
  props: {
    title: { type: 'string', description: 'Heading' },
    services: {
      type: 'array',
      required: true,
      items: {
        id: { type: 'string', required: true, description: 'Row id' },
        name: { type: 'string', required: true, description: 'Row name' },
      },
      description: 'The rows',
    },
  },
  publishes: {},
  actions: {},
};

const CARD_FIXTURE: ComponentContract = {
  component: 'Card',
  purpose: 'Fixture card screen.',
  props: {
    question: { type: 'string', required: true, description: 'Question' },
    answer: { type: 'string', description: 'Answer' },
    canAnswer: { type: 'boolean', description: 'Answerable' },
  },
  publishes: {},
  actions: {},
};

describe('derived fallback projection', () => {
  it('a contract with no fallbackTemplate still projects, without the model writing one', () => {
    const result = buildSurfaceEvents({
      surfaceId: 'screen-1',
      contract: CATALOG_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: { title: 'Rows', services: ['a', 'b'], count: 2 },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(result.fallbackMarkdown, '# Rows\n- services: 2 items\n- count: 2');
  });

  it('the contract template wins over the derived floor', () => {
    const templated = { ...CATALOG_FIXTURE, fallbackTemplate: () => '# From the contract' };
    const result = buildSurfaceEvents({
      surfaceId: 'screen-1',
      contract: templated,
      catalogId: 'fixture:catalog-v1',
      props: { title: 'Rows', services: [] },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(result.fallbackMarkdown, '# From the contract');
  });

  it('gives contract fallbacks the committed session formatter', () => {
    const templated: ComponentContract = {
      ...CATALOG_FIXTURE,
      fallbackTemplate: (props, localization) =>
        localization?.format('fixture.rows', { count: (props.services as unknown[]).length }) ?? '',
    };
    const result = buildSurfaceEvents({
      surfaceId: 'screen-1',
      contract: templated,
      catalogId: 'fixture:catalog-v1',
      props: { services: ['a', 'b'] },
      localization: {
        format: (messageId, values) => `${messageId}: ${String(values?.count)} Zeilen`,
      },
    });

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.fallbackMarkdown, 'fixture.rows: 2 Zeilen');
    }
  });
});

describe('buildSurfaceEvents', () => {
  it('happy path: builds createSurface + updateComponents with the root node', () => {
    const result = buildSurfaceEvents({
      surfaceId: 'screen-1',
      contract: CATALOG_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: { title: 'Rows', services: [] },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(result.events.length, 2);

    const [createEvent, updateEvent] = result.events;
    assert.strictEqual(createEvent?.name, 'agentplace.a2ui.createSurface');
    assert.deepStrictEqual(createEvent?.value, {
      surfaceId: 'screen-1',
      catalogId: 'fixture:catalog-v1',
      fallbackMarkdown: '# Rows\n- services: 0 items',
    });

    assert.strictEqual(updateEvent?.name, 'agentplace.a2ui.updateComponents');
    assert.deepStrictEqual(updateEvent?.value, {
      surfaceId: 'screen-1',
      components: [
        {
          title: 'Rows',
          services: [],
          id: 'root',
          component: 'Catalog',
        },
      ],
    });
  });

  it('missing required prop → ok:false with the validation problem', () => {
    const result = buildSurfaceEvents({
      surfaceId: 'x',
      contract: CATALOG_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: {},
    });
    assert.strictEqual(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.ok(result.error.includes('Missing required prop "services"'));
  });

  it('props with id/component keys do not break the root node (id/component win, spread last)', () => {
    const result = buildSurfaceEvents({
      surfaceId: 's1',
      contract: CARD_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: { id: 'hijacked', component: 'Hijacked', question: 'q', answer: 'a', canAnswer: true },
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    const updateEvent = result.events[1];
    const value = updateEvent?.value as { components: Array<Record<string, unknown>> };
    assert.deepStrictEqual(value.components[0], {
      question: 'q',
      answer: 'a',
      canAnswer: true,
      id: 'root',
      component: 'Card',
    });
  });
});

describe('splitToolInput', () => {
  it('divides a flat tool input into surfaceId/props/dataModel/fallbackMarkdown', () => {
    const result = splitToolInput(CATALOG_FIXTURE, {
      surfaceId: 'screen-1',
      title: 'Rows',
      services: [{ id: 'row-1', name: 'Row' }],
      dataModel: { chips: ['Next'] },
      notAContractProp: 'ignored-by-props',
    });

    assert.strictEqual(result.surfaceId, 'screen-1');
    assert.deepStrictEqual(result.props, {
      title: 'Rows',
      services: [{ id: 'row-1', name: 'Row' }],
    });
    assert.deepStrictEqual(result.dataModel, { chips: ['Next'] });
  });

  it('missing dataModel → undefined; missing surfaceId → empty string', () => {
    const result = splitToolInput(CARD_FIXTURE, { question: 'q' });
    assert.strictEqual(result.surfaceId, '');
    assert.strictEqual(result.dataModel, undefined);
    assert.deepStrictEqual(result.props, { question: 'q' });
  });

  it('a stray voiceSummary arg goes nowhere — not into props, not into the result', () => {
    const result = splitToolInput(CARD_FIXTURE, {
      surfaceId: 's-1',
      voiceSummary: 'A stale caller may still send this.',
    });
    assert.strictEqual('voiceSummary' in result.props, false);
    assert.strictEqual('voiceSummary' in result, false);
  });
});

describe('splitToolInput — stray unicode escapes', () => {
  it('decodes \\uXXXX sequences left in surface-bound strings, at any depth', () => {
    const result = splitToolInput(CATALOG_FIXTURE, {
      surfaceId: 'screen-1',
      title: '3 homes in Birmingham from \\u00a3220 to \\u00a3310 a week',
      services: [{ id: 'row-1', name: 'from \\u00a3233.31/week' }],
      dataModel: { note: 'save \\u20ac5' },
      chips: ['Budget \\u00a3220'],
    });

    assert.strictEqual(result.props['title'], '3 homes in Birmingham from £220 to £310 a week');
    assert.deepStrictEqual(result.props['services'], [{ id: 'row-1', name: 'from £233.31/week' }]);
    assert.deepStrictEqual(result.dataModel, { note: 'save €5' });
    assert.deepStrictEqual(result.chips, ['Budget £220']);
  });

  it('leaves already-decoded text and non-string values untouched', () => {
    const result = splitToolInput(CATALOG_FIXTURE, {
      surfaceId: 'screen-1',
      title: 'from £220 to £310 a week',
      services: [{ id: 'row-1', name: 'Bridge Street', rooms: 5, featured: true }],
    });

    assert.strictEqual(result.props['title'], 'from £220 to £310 a week');
    assert.deepStrictEqual(result.props['services'], [
      { id: 'row-1', name: 'Bridge Street', rooms: 5, featured: true },
    ]);
  });

  it('decodes surrogate pairs and leaves lone surrogates as written', () => {
    const result = splitToolInput(CARD_FIXTURE, {
      question: 'Booked \\ud83c\\udf89 — lone \\ud83c stays',
    });

    assert.strictEqual(result.props['question'], 'Booked 🎉 — lone \\ud83c stays');
  });

  it('leaves invalid hex and backslash-preceded sequences as written', () => {
    const result = splitToolInput(CARD_FIXTURE, {
      question: 'literal \\\\u00a3 and bad \\uZZZZ stay',
    });

    assert.strictEqual(result.props['question'], 'literal \\\\u00a3 and bad \\uZZZZ stay');
  });
});

describe('mergeSeedIntoUiState', () => {
  it('routes pointer-form keys to the uiState root and bare keys under the surface', () => {
    const result = mergeSeedIntoUiState({ existing: 1 }, 'menu-page', {
      '/chips': ['Book now', 'Opening hours'],
      '/nav': [{ label: 'Menu', intent: 'Show the menu' }],
      selectedDate: '2026-07-09',
    });
    assert.deepStrictEqual(result.chips, ['Book now', 'Opening hours']);
    assert.deepStrictEqual(result.nav, [{ label: 'Menu', intent: 'Show the menu' }]);
    assert.deepStrictEqual(result.surfaces, { 'menu-page': { selectedDate: '2026-07-09' } });
    assert.strictEqual(result.existing, 1);
  });

  it('preserves other surfaces and overwrites the seeded one', () => {
    const current = { surfaces: { other: { a: 1 }, 'menu-page': { stale: true } } };
    const result = mergeSeedIntoUiState(current, 'menu-page', { fresh: true });
    assert.deepStrictEqual(result.surfaces, { other: { a: 1 }, 'menu-page': { fresh: true } });
  });

  it('handles a non-record current document', () => {
    const result = mergeSeedIntoUiState(null, 's1', { '/chips': ['x'], k: 'v' });
    assert.deepStrictEqual(result, { chips: ['x'], surfaces: { s1: { k: 'v' } } });
  });
});

describe('contract hooks in buildSurfaceEvents', () => {
  const HOOKED_FIXTURE: ComponentContract = {
    component: 'Hooked',
    purpose: 'Hook fixture.',
    props: { title: { type: 'string', description: 'Title' } },
    publishes: {},
    actions: {},
    validateProps: (props) => (props.title === 'bad' ? ['title is bad.'] : []),
    compose: (props) => [
      { id: 'root', component: 'Column', children: ['s0'] },
      { id: 's0', component: 'Text', text: String(props.title ?? '') },
    ],
  };

  it('validateProps problems fail the build alongside standard validation', () => {
    const result = buildSurfaceEvents({
      surfaceId: 'x',
      contract: HOOKED_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: { title: 'bad' },
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.ok === false && result.error.includes('title is bad.'));
  });

  it('compose replaces the single-root default with the returned node list', () => {
    const result = buildSurfaceEvents({
      surfaceId: 'x',
      contract: HOOKED_FIXTURE,
      catalogId: 'fixture:catalog-v1',
      props: { title: 'Hello' },
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      const update = result.events[1];
      assert.deepStrictEqual(update?.value, {
        surfaceId: 'x',
        components: [
          { id: 'root', component: 'Column', children: ['s0'] },
          { id: 's0', component: 'Text', text: 'Hello' },
        ],
      });
    }
  });
});

describe('buildSurfaceEvents — carry-forward', () => {
  const PROSE: ComponentContract = {
    component: 'Prose',
    purpose: 'Fixture prose section.',
    props: { markdown: { type: 'string', required: true, description: 'Body' } },
    publishes: {},
    actions: {},
    fallbackTemplate: (props) => String(props.markdown ?? ''),
  };
  const SIGNUP: ComponentContract = {
    component: 'Signup',
    purpose: 'Fixture interactive section.',
    props: {
      fields: { type: 'array', required: true, items: {}, description: 'Fields' },
    },
    publishes: { '/signup/{id}': { valueType: 'string' } },
    actions: { submit: { context: {} } },
    fallbackTemplate: () => 'Signup form',
  };
  const stack = () => createSectionStackContract({ Prose: PROSE, Signup: SIGNUP });

  const answerOnly = {
    sections: [{ component: 'Prose', props: { markdown: 'We are open until six.' } }],
  };
  const carried = [{ component: 'Signup', props: { fields: [{ id: 'email' }] } }];

  function build(props: Record<string, unknown>, carryForward: unknown[] | null) {
    return buildSurfaceEvents({
      contract: stack(),
      catalogId: 'fixture:v1',
      surfaceId: 'screen-1',
      props,
      carryForward,
    });
  }

  function componentIds(result: ReturnType<typeof buildSurfaceEvents>): string[] {
    if (result.ok !== true) {
      return [];
    }
    const update = result.events.find((e) => e.name.endsWith('updateComponents'));
    const value = update?.value as { components: Array<{ id: string }> };
    return value.components.map((c) => c.id);
  }

  it('appends an interactive section the new composition omitted', () => {
    const ids = componentIds(build(answerOnly, carried));
    assert.ok(ids.some((id) => id.startsWith('Prose-')));
    assert.ok(
      ids.some((id) => id.startsWith('Signup-')),
      'the form must survive the answer',
    );
  });

  it('does nothing when there is no live screen to carry from', () => {
    const ids = componentIds(build(answerOnly, null));
    assert.strictEqual(
      ids.some((id) => id.startsWith('Signup-')),
      false,
    );
  });

  it('does not duplicate a section the model re-sent itself', () => {
    const withForm = {
      sections: [
        ...answerOnly.sections,
        { component: 'Signup', props: { fields: [{ id: 'email' }] } },
      ],
    };
    const ids = componentIds(build(withForm, carried));
    assert.strictEqual(ids.filter((id) => id.startsWith('Signup-')).length, 1);
  });

  it('does not carry a display-only section — only interactive ones', () => {
    const ids = componentIds(
      build(answerOnly, [{ component: 'Prose', props: { markdown: 'old' } }]),
    );
    assert.strictEqual(ids.filter((id) => id.startsWith('Prose-')).length, 1);
  });

  it('regenerates fallbackMarkdown so it describes the carried section too', () => {
    const result = build({ ...answerOnly, fallbackMarkdown: 'We are open until six.' }, carried);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.match(
        result.fallbackMarkdown,
        /Signup form/,
        'a model-authored fallback describes only its own answer — voice would then claim the form is gone',
      );
    }
  });
});
