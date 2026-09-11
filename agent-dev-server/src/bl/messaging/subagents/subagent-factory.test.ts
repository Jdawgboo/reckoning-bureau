import { describe, test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { IToolRegistry, SubagentConfig } from '../../agent/agent-library';
import type { ModelProvider } from '../../agent/interfaces';
import type { AgentStorageFactoryService } from '../../../services/agent-storage-factory.service';
import { createAgentSubagents } from './subagent-factory.ts';
import { SUBAGENT_DEFAULT_MODEL, type SubagentModelResolver } from './subagent-model-resolver.ts';

type Subagents = SubagentConfig[];

function makeFakeModel(label: string): LanguageModelV3 {
  return { __label: label } as unknown as LanguageModelV3;
}

// Stands in for `buildSubagentModelResolver`'s output — resolves any short-name.
function happyResolver(): SubagentModelResolver {
  return (shortName) => ({
    model: makeFakeModel(shortName),
    modelSettings: { maxOutputTokens: 1000, providerOptions: {} },
  });
}

function makeFakeVertex(): GoogleVertexProvider {
  return {
    tools: {
      urlContext: () => ({ type: 'provider-defined' }),
    },
  } as unknown as GoogleVertexProvider;
}

function makeArgs(overrides: {
  modelProvider: ModelProvider;
  modelResolver?: SubagentModelResolver | null;
}): Parameters<typeof createAgentSubagents>[0] {
  return {
    parentRegistry: { getAllTools: () => [] } as unknown as IToolRegistry,
    defaultModel: makeFakeModel('default'),
    modelResolver:
      overrides.modelResolver === undefined ? happyResolver() : overrides.modelResolver,
    modelProvider: overrides.modelProvider,
    storageFactory: {} as unknown as AgentStorageFactoryService,
    gatewayBaseUrl: 'https://gateway.test',
    accessKey: 'test-key',
    agentId: 'agent-test',
  };
}

// Resolver pre-caches every model — `getModel` returns one for any modelId.
function happyModelProvider(): ModelProvider {
  return {
    getModel: async (modelId: string) => makeFakeModel(modelId),
    getVertexProvider: () => makeFakeVertex(),
  } as ModelProvider;
}

function findByType(subagents: Subagents, type: string): SubagentConfig | undefined {
  return subagents.find((s) => s.type === type);
}

let warnCalls: unknown[][];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnCalls = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

describe('createAgentSubagents', () => {
  test('always includes general-purpose, even when there is no resolver', async () => {
    const subagents = await createAgentSubagents(
      makeArgs({ modelProvider: happyModelProvider(), modelResolver: null }),
    );
    assert.ok(
      findByType(subagents, 'general-purpose'),
      'general-purpose subagent must always be present',
    );
    assert.equal(findByType(subagents, 'code-executor'), undefined);
    assert.equal(findByType(subagents, 'page-fetcher'), undefined);
    // Exactly one warn — the missing-resolver early return, not a per-subagent branch.
    assert.equal(warnCalls.length, 1, 'exactly one warn when there is no resolver');
    assert.match(
      String(warnCalls[0]?.[0]),
      /no model resolver/,
      'warn must identify the missing resolver',
    );
  });

  test('general-purpose runs on the platform default, not the agent model', async () => {
    const subagents = await createAgentSubagents(makeArgs({ modelProvider: happyModelProvider() }));
    const generalPurpose = findByType(subagents, 'general-purpose');
    assert.deepEqual(generalPurpose?.model, makeFakeModel(SUBAGENT_DEFAULT_MODEL));
    assert.match(generalPurpose?.description ?? '', /gemini-flash/);
  });

  test('general-purpose falls back to the agent model when nothing resolves', async () => {
    const subagents = await createAgentSubagents(
      makeArgs({ modelProvider: happyModelProvider(), modelResolver: null }),
    );
    const generalPurpose = findByType(subagents, 'general-purpose');
    assert.deepEqual(generalPurpose?.model, makeFakeModel('default'));
    // No resolver → the tool exposes no model param, so the description must not promise one.
    assert.doesNotMatch(generalPurpose?.description ?? '', /gemini-flash|pass model/);
  });

  test('general-purpose still ships when resolving the default throws', async () => {
    const subagents = await createAgentSubagents(
      makeArgs({
        modelProvider: happyModelProvider(),
        modelResolver: (shortName) => {
          if (shortName === SUBAGENT_DEFAULT_MODEL) {
            throw new Error('resolver blew up');
          }
          return {
            model: makeFakeModel(shortName),
            modelSettings: { maxOutputTokens: 1, providerOptions: {} },
          };
        },
      }),
    );
    assert.deepEqual(findByType(subagents, 'general-purpose')?.model, makeFakeModel('default'));
    assert.ok(
      warnCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('default subagent model'),
      ),
    );
  });

  test('happy path: returns general-purpose + code-executor + page-fetcher', async () => {
    const subagents = await createAgentSubagents(makeArgs({ modelProvider: happyModelProvider() }));
    assert.ok(findByType(subagents, 'general-purpose'));
    assert.ok(findByType(subagents, 'code-executor'));
    assert.ok(
      findByType(subagents, 'page-fetcher'),
      'page-fetcher must be in the returned array when flash-lite resolves and Vertex provider is available',
    );
  });

  test('page-fetcher is skipped with a warning when getVertexProvider is missing', async () => {
    const subagents = await createAgentSubagents(
      makeArgs({
        modelProvider: {
          getModel: async (modelId: string) => makeFakeModel(modelId),
          // getVertexProvider omitted
        } as ModelProvider,
      }),
    );
    assert.ok(findByType(subagents, 'general-purpose'));
    assert.ok(findByType(subagents, 'code-executor'));
    assert.equal(findByType(subagents, 'page-fetcher'), undefined);
    assert.ok(
      warnCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('Vertex provider not available'),
      ),
      'expected a warn that mentions the missing Vertex provider',
    );
  });

  test('a failure in one optional subagent does not block the others', async () => {
    // getVertexProvider throws — page-fetcher should fail but code-executor
    // should still be created.
    const subagents = await createAgentSubagents(
      makeArgs({
        modelProvider: {
          getModel: async (modelId: string) => makeFakeModel(modelId),
          getVertexProvider: () => {
            throw new Error('vertex blew up');
          },
        } as ModelProvider,
      }),
    );
    assert.ok(findByType(subagents, 'general-purpose'));
    assert.ok(
      findByType(subagents, 'code-executor'),
      'code-executor must survive a page-fetcher failure',
    );
    assert.equal(findByType(subagents, 'page-fetcher'), undefined);
  });
});
