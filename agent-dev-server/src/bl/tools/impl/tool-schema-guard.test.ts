/**
 * Guard for the generic surface-tool factory: runs against FIXTURE contracts —
 * platform tests must not depend on agent-zone content. The agent's real
 * contracts are held to the same dialect rules by `src/surfaces/index.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSurfaceTools } from './render-surface.tool.ts';
import { assertProviderSafeToolSchema } from './schema-dialect-guards.ts';
import { isRecord } from '../../../util/type-guards.ts';
import type { ComponentContract } from '../../../../vendor/agentplace-a2ui/contract-schema.ts';

/** Fixture contracts exercising every PropSpec feature: enum, nested
 *  array-of-object items, object props, required flags. */
const FIXTURE_CONTRACTS: Record<string, ComponentContract> = {
  Alpha: {
    component: 'Alpha',
    purpose: 'Fixture screen with an item list.',
    props: {
      heading: { type: 'string', required: true, description: 'Heading' },
      entries: {
        type: 'array',
        required: true,
        items: {
          id: { type: 'string', required: true, description: 'Entry id' },
          tags: {
            type: 'array',
            items: { name: { type: 'string', required: true, description: 'Tag name' } },
            description: 'Nested list',
          },
        },
        description: 'The entries',
      },
    },
    publishes: { '/alpha/pick': { valueType: 'string' } },
    actions: { pick: { context: { id: { type: 'string', description: 'picked id' } } } },
  },
  Beta: {
    component: 'Beta',
    purpose: 'Fixture screen with an enum and a binding.',
    props: {
      mode: { type: 'string', enum: ['one', 'two'], description: 'Mode' },
      value: { type: 'object', description: 'Binding: {path}' },
    },
    publishes: {},
    actions: {},
  },
};

describe('surface tool factory (platform guard, fixture contracts)', () => {
  const tools = createSurfaceTools({
    contracts: FIXTURE_CONTRACTS,
    catalogId: 'fixture:catalog-v1',
    stateTree: null,
    sessionKey: 'test-session',
  });

  it('produces one Render<Component> tool per contract', () => {
    assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), ['RenderAlpha', 'RenderBeta']);
  });

  it('threads the contract purpose into the tool description', () => {
    const alpha = tools.find((tool) => tool.name === 'RenderAlpha');
    assert.ok(alpha?.description?.includes('Fixture screen with an item list.'));
  });

  it('every generated schema passes both provider dialects (Bedrock + Gemini proto)', () => {
    for (const tool of tools) {
      const parametersSchema = tool.parametersSchema;
      if (!isRecord(parametersSchema) || !isRecord(parametersSchema['jsonSchema'])) {
        throw new Error(`${tool.name}: parametersSchema is not a jsonSchema() wrapper`);
      }
      assertProviderSafeToolSchema(parametersSchema['jsonSchema'], tool.name);
    }
  });
});
