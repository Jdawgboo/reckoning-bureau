import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createContextManagement } from './context-management.config.ts';
import {
  InterleavedThinkingFixMiddleware,
  BrokenToolInputFixMiddleware,
  ReasoningStreamFixMiddleware,
  CompactionMiddleware,
  CacheStrategyMiddleware,
  ContextBudgetGuardMiddleware,
} from '../agent/agent-library.ts';

/**
 * The deployed chain, in order.
 *
 * `InterleavedThinkingFixMiddleware` and `BrokenToolInputFixMiddleware` were
 * added when I1 was closed (deployed agents previously had neither, so a
 * truncated Bedrock generation went unrepaired). This test kept asserting the
 * old four-middleware stack and had been red since — the capability landed, its
 * pin did not.
 */
const EXPECTED_CHAIN = [
  InterleavedThinkingFixMiddleware,
  BrokenToolInputFixMiddleware,
  ReasoningStreamFixMiddleware,
  CompactionMiddleware,
  CacheStrategyMiddleware,
  ContextBudgetGuardMiddleware,
] as const;

function assertChain(middlewares: readonly unknown[]): void {
  assert.strictEqual(
    middlewares.length,
    EXPECTED_CHAIN.length,
    `deployed chain length changed: expected ${EXPECTED_CHAIN.length}, got ${middlewares.length}. ` +
      'Order and membership are load-bearing — the repair middlewares must precede compaction, ' +
      'and the budget guard must run last',
  );
  EXPECTED_CHAIN.forEach((Middleware, index) => {
    assert.ok(
      middlewares[index] instanceof Middleware,
      `position ${index} must be ${Middleware.name}, got ${middlewares[index]?.constructor?.name}`,
    );
  });
}

function fakeStorage() {
  const writes: string[] = [];
  return {
    writes,
    writeFile: async (path: string) => {
      writes.push(path);
    },
  };
}

const fakeModel: LanguageModelV3 = {
  specificationVersion: 'v3',
  provider: 'test',
  modelId: 'test-model',
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error('not used');
  },
  doStream: async () => {
    throw new Error('not used');
  },
};

const baseParams = {
  compactionScope: 'main',
  modelName: 'claude-sonnet-5',
  modelProvider: { getModel: async () => fakeModel },
  gatewayBaseUrl: 'https://gw.test/api/gateway',
  accessKey: 'k',
};

describe('createContextManagement', () => {
  it('returns the deployed middleware stack in order', () => {
    const cm = createContextManagement({
      compactionScope: 'main',
      ...baseParams,
      storage: fakeStorage() as never,
      sessionKey: 's1',
    });
    assertChain(cm.modelMiddlewares);
  });

  it('with a sessionKey, offloading uses builder-parity tuning', () => {
    const cm = createContextManagement({
      compactionScope: 'main',
      ...baseParams,
      storage: fakeStorage() as never,
      sessionKey: 's1',
    });
    assert.strictEqual(cm.fileFirstConfig?.offloadThreshold, 15_000);
    assert.strictEqual(cm.fileFirstConfig?.previewHeadLines, 20);
    assert.strictEqual(cm.fileFirstConfig?.previewTailLines, 10);
    assert.strictEqual(cm.fileFirstConfig?.previewLineMaxChars, 1000);
  });

  it('without a sessionKey, offloading is disabled', () => {
    const cm = createContextManagement({ ...baseParams, storage: fakeStorage() as never });
    assert.strictEqual(cm.fileFirstConfig, undefined);
  });

  it('fileFirstConfig.write goes through storage.writeFile', async () => {
    const storage = fakeStorage();
    const cm = createContextManagement({
      compactionScope: 'main',
      ...baseParams,
      storage: storage as never,
      sessionKey: 's1',
    });
    const ok = await cm.fileFirstConfig?.write('tool-results/s1/tc.txt', 'content');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(storage.writes, ['tool-results/s1/tc.txt']);
  });

  // The middlewares hold the injected estimator behind a private field, so
  // this can only assert construction and stack shape — not that the bare
  // HeuristicTokenEstimator was omitted (see createContextManagement JSDoc).
  it('heuristic-only providers (grok) still yield the full middleware stack', () => {
    const cm = createContextManagement({
      compactionScope: 'main',
      ...baseParams,
      modelName: 'grok-4.3',
      storage: fakeStorage() as never,
      sessionKey: 's1',
    });
    assertChain(cm.modelMiddlewares);
  });
});
