import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  contractToFlatToolSchema,
  type ComponentContract,
  validateContractShape,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { assembleSurfaceContracts } from '../builtin-catalog/assemble-surface-contracts.ts';
import { BUILTIN_SURFACE_CONTRACTS } from '../builtin-catalog/index.ts';

const HEALTHY = {
  component: 'BookingSummary',
  purpose: 'Confirm a booking',
  props: {
    reference: { type: 'string', required: true, description: 'Booking reference' },
    nights: { type: 'number', description: 'Nights booked' },
    guests: {
      type: 'array',
      description: 'Guests on the booking',
      items: {
        name: { type: 'string', description: 'Guest name' },
        adult: { type: 'boolean', description: 'Adult, not a child' },
      },
    },
  },
  publishes: {},
  actions: { confirm: { context: { reference: { type: 'string', description: 'Reference' } } } },
} satisfies ComponentContract;

function messagesFor(contract: unknown): string[] {
  return validateContractShape(contract).map((problem) => `${problem.path}: ${problem.message}`);
}

describe('validateContractShape', () => {
  it('reports nothing for a well-formed contract', () => {
    assert.deepStrictEqual(validateContractShape(HEALTHY), []);
  });

  it('treats omitted capability maps as no writes and no actions', () => {
    const { publishes: _publishes, actions: _actions, ...displayOnly } = HEALTHY;
    assert.deepStrictEqual(validateContractShape(displayOnly), []);
    assert.doesNotThrow(() => contractToFlatToolSchema(displayOnly));
  });

  it('names an unknown top-level field', () => {
    const problems = validateContractShape({ ...HEALTHY, placement: 'stage' });

    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].path, 'placement');
    assert.match(problems[0].message, /unknown field "placement"/);
    assert.strictEqual(problems[0].severity, 'warning');
  });

  it('catches the array items written as JSON Schema', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: {
        worldClocks: {
          type: 'array',
          description: 'World clock cards',
          items: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
              country: { type: 'string', description: 'Country name' },
            },
          },
        },
      },
    });

    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].path, 'props.worldClocks.items');
    assert.match(problems[0].message, /JSON-Schema "properties" key/);
  });

  it('catches JSON Schema written one level up, on the prop itself', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: {
        profile: {
          type: 'object',
          description: 'Visitor profile',
          properties: { name: { type: 'string', description: 'Name' } },
        },
      },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['props.profile'],
    );
  });

  it('walks into a field map, so a nested array is checked too', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: {
        table: {
          type: 'array',
          description: 'Rows',
          items: {
            label: { type: 'string', description: 'Row label' },
            cells: { type: 'array', description: 'Cells in the row' },
          },
        },
      },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['props.table.items.cells'],
    );
  });

  it('walks an action context, which reaches no tool schema at all', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      actions: { confirm: { context: { reference: { type: 'string' } } } },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['actions.confirm.context.reference'],
    );
    assert.match(problems[0].message, /no description/);
  });

  it('catches an array with no items — the defect a typecheck cannot see', () => {
    const problems = messagesFor({
      ...HEALTHY,
      props: { tags: { type: 'array', description: 'Tags' } },
    });

    assert.deepStrictEqual(problems, [
      'props.tags: array without items — providers reject the schema and the model gets no element shape',
    ]);
  });

  it('catches a type outside PropType', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: { count: { type: 'integer', description: 'How many' } },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['props.count'],
    );
    assert.match(problems[0].message, /is not a PropSpec type/);
  });

  it('reports a missing description', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: { reference: { type: 'string' } },
    });

    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /no description/);
  });

  it('requires props but not capability maps', () => {
    const problems = validateContractShape({
      component: 'Bare',
      purpose: 'Nothing',
      publishes: {},
    });

    assert.deepStrictEqual(
      problems.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'props', severity: 'error' }],
    );
  });

  it('reports a prop that collides with a reserved authoring param', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: { surfaceId: { type: 'string', description: 'Which screen' } },
    });

    assert.deepStrictEqual(
      problems.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'props.surfaceId', severity: 'error' }],
    );
  });

  it('reports object items that carry no field map, which document nothing', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: {
        rows: {
          type: 'array',
          description: 'Rows',
          items: { type: 'object', description: 'One row' },
        },
      },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['props.rows.items'],
    );
  });

  it('leaves a two-way binding prop alone — an object with no items is how the skill teaches it', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      props: {
        email: { type: 'object', description: 'Binding: {path: "/lead/email"}' },
      },
    });

    assert.deepStrictEqual(problems, []);
  });

  it('reports props, publishes, and actions that are not maps at all', () => {
    const asArray = validateContractShape({ ...HEALTHY, props: [] });
    const asNull = validateContractShape({ ...HEALTHY, publishes: null });
    const asString = validateContractShape({ ...HEALTHY, actions: 'confirm' });

    assert.deepStrictEqual(
      asArray.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'props', severity: 'error' }],
    );
    assert.deepStrictEqual(
      asNull.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'publishes', severity: 'error' }],
    );
    assert.deepStrictEqual(
      asString.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'actions', severity: 'error' }],
    );
  });

  it('reports an action declaration that is not { context }', () => {
    const problems = validateContractShape({ ...HEALTHY, actions: { go: 'ctx' } });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['actions.go'],
    );
  });

  it('reports malformed publish declarations before a render can inspect them', () => {
    const problems = validateContractShape({
      ...HEALTHY,
      publishes: {
        '/missing': null,
        '/unsupported': { valueType: 'array' },
      },
    });

    assert.deepStrictEqual(
      problems.map((problem) => problem.path),
      ['publishes./missing', 'publishes./unsupported.valueType'],
    );
  });

  it('treats an empty component name as missing', () => {
    const problems = validateContractShape({ ...HEALTHY, component: '' });

    assert.deepStrictEqual(
      problems.map((problem) => ({ path: problem.path, severity: problem.severity })),
      [{ path: 'component', severity: 'error' }],
    );
  });

  it('stops on a self-referencing spec instead of recursing until the stack dies', () => {
    const spec: Record<string, unknown> = { type: 'array', description: 'Loops' };
    spec['items'] = spec;

    const problems = validateContractShape({ ...HEALTHY, props: { loop: spec } });

    assert.ok(problems.length > 0);
    assert.match(problems[problems.length - 1].message, /nested deeper than/);
  });

  it('reports a non-object without throwing', () => {
    assert.deepStrictEqual(validateContractShape(null), [
      { contract: '<unnamed>', path: '', message: 'not an object', severity: 'error' },
    ]);
  });

  it('holds the platform catalog to the same bar', () => {
    const { builtinContracts } = assembleSurfaceContracts({}, BUILTIN_SURFACE_CONTRACTS);
    const problems = Object.values(builtinContracts).flatMap((contract) =>
      validateContractShape(contract),
    );

    assert.deepStrictEqual(problems, []);
  });
});

describe('the schema a reported contract would have produced', () => {
  it('drops every item field when items is written as JSON Schema', () => {
    // Parsed, not written as a literal: TypeScript rejects this shape, and the
    // bundle that ships it has already erased the types that would have caught it.
    const contract = JSON.parse(`{
      "component": "WorldClocks",
      "purpose": "Show clocks",
      "publishes": {},
      "actions": {},
      "props": {
        "worldClocks": {
          "type": "array",
          "description": "World clock cards",
          "items": {
            "type": "object",
            "properties": { "city": { "type": "string", "description": "City name" } }
          }
        }
      }
    }`);
    const schema = contractToFlatToolSchema(contract);
    const properties = schema['properties'];
    const worldClocks =
      typeof properties === 'object' && properties !== null
        ? (properties as Record<string, unknown>)['worldClocks']
        : undefined;

    assert.deepStrictEqual(worldClocks, {
      type: 'array',
      description: 'World clock cards',
      items: { type: 'object', description: undefined },
    });
  });
});
