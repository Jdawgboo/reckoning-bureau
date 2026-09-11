import assert from 'node:assert';
import { describe, it } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { StorageFileMetadata } from '../../../vendor/agent-library/index.ts';
import {
  buildSummarizerInput,
  createAgentCompactionSummarizer,
} from './agent-compaction-summarizer.ts';

const GARBAGE = 'Wait, let us search the platform model list once more today!\n'.repeat(30);
const HEALTHY = 'Scaffolded the landing page and connected the CRM webhook end to end.';

function makeRecordingModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function makeStorage(written: string[]) {
  return {
    listFiles: async (): Promise<StorageFileMetadata[]> => [],
    exists: async () => false,
    resolvePath: (p: string) => ({
      adapter: 'tool-results',
      relativePath: p.replace(/^tool-results\//, '').replace(/\/$/, ''),
    }),
    writeFile: async (path: string) => {
      written.push(path);
      return { path, adapter: 'tool-results' };
    },
  };
}

const failingModelProvider = {
  getModel: async () => {
    throw new Error('model unavailable');
  },
};

describe('createAgentCompactionSummarizer', () => {
  it('rethrows on LLM failure instead of returning a digest', async () => {
    const summarize = createAgentCompactionSummarizer(failingModelProvider, {
      storage: makeStorage([]),
      sessionKey: 'sess-1',
      compactionScope: 'main',
    });
    await assert.rejects(
      summarize({ serializedNarrative: 'N', previousSummary: null, collapsedPairs: [] }),
      /model unavailable/,
    );
  });

  it('derives the history dump path from the compaction scope', async () => {
    const written: string[] = [];
    const summarize = createAgentCompactionSummarizer(failingModelProvider, {
      storage: makeStorage(written),
      sessionKey: 'sess-1',
      compactionScope: 'sub-researcher-tooluse_abc',
    });
    await assert.rejects(
      summarize({ serializedNarrative: 'N', previousSummary: null, collapsedPairs: [] }),
    );
    assert.deepStrictEqual(written, [
      'tool-results/compaction/sub-researcher-tooluse_abc/compaction-history-1.md',
    ]);
  });

  it('skips the history dump when no sessionKey is set', async () => {
    const written: string[] = [];
    const summarize = createAgentCompactionSummarizer(failingModelProvider, {
      storage: makeStorage(written),
      compactionScope: 'main',
    });
    await assert.rejects(
      summarize({ serializedNarrative: 'N', previousSummary: null, collapsedPairs: [] }),
    );
    assert.deepStrictEqual(written, []);
  });

  it('degenerate primary: retried once on a different model; fallback call has NO temperature (PR #723 pin)', async () => {
    const models: MockLanguageModelV3[] = [];
    const names: string[] = [];
    const modelProvider = {
      getModel: async (name: string) => {
        names.push(name);
        const model = makeRecordingModel(models.length === 0 ? GARBAGE : HEALTHY);
        models.push(model);
        return model;
      },
    };
    const summarize = createAgentCompactionSummarizer(modelProvider, {
      storage: makeStorage([]),
      sessionKey: 'sess-1',
      compactionScope: 'main',
    });
    const result = await summarize({
      serializedNarrative: 'NARRATIVE',
      previousSummary: null,
      collapsedPairs: [],
    });
    assert.strictEqual(names.length, 2);
    assert.notStrictEqual(names[0], names[1]);
    assert.ok(result.includes(HEALTHY));
    assert.ok(result.includes('compaction/main/compaction-history-1.md'));
    assert.strictEqual(models[0].doGenerateCalls[0].temperature, 0);
    assert.strictEqual(models[1].doGenerateCalls[0].temperature, undefined);
  });
});

describe('buildSummarizerInput', () => {
  it('appends an informational note without instructing the model to cite the path', () => {
    const input = buildSummarizerInput(
      'NARRATIVE',
      null,
      'tool-results/compaction/main/compaction-history-1.md',
    );
    assert.ok(input.includes('NARRATIVE'));
    assert.ok(input.includes('tool-results/compaction/main/compaction-history-1.md'));
    assert.ok(!input.toLowerCase().includes('mention this path'));
  });

  it('includes the previous summary block when present', () => {
    const input = buildSummarizerInput('N', 'PREV', null);
    assert.ok(input.startsWith('<previous-summary>\nPREV\n</previous-summary>'));
    assert.ok(!input.includes('compaction-history'));
  });

  it('strips prior pointer lines from the previous summary', () => {
    const prev =
      'Goal line.\nFull pre-compaction history of this session is stored in "tool-results/compaction/main/" (compaction-history-*.md, one file per compaction; latest: "x"). List or read it if you need exact details from before this summary.';
    const input = buildSummarizerInput('N', prev, null);
    assert.ok(input.includes('Goal line.'));
    assert.ok(!input.includes('is stored in "tool-results/compaction/main/"'));
  });
});

describe('cross-vendor fallback on primary call failure (AGE-383 incident addendum)', () => {
  it('primary model throws (429/outage): the Bedrock fallback summarizes instead', async () => {
    const written: string[] = [];
    const engines: string[] = [];
    const provider = {
      getModel: async (name: string) => {
        engines.push(name);
        if (engines.length === 1) {
          throw new Error('Resource exhausted (429)');
        }
        return makeRecordingModel(HEALTHY);
      },
    };
    const summarize = createAgentCompactionSummarizer(provider, {
      storage: makeStorage(written),
      sessionKey: 'sess-1',
      compactionScope: 'main',
    });
    const result = await summarize({
      serializedNarrative: 'N',
      previousSummary: null,
      collapsedPairs: [],
    });
    assert.ok(result.includes(HEALTHY), 'fallback summary must be used');
    assert.strictEqual(engines.length, 2, 'both engines attempted');
    assert.notStrictEqual(engines[0], engines[1], 'pair must span two model ids');
  });
});
