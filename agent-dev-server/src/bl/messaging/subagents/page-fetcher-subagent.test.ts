import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import { createPageFetcherSubagent } from './page-fetcher-subagent.ts';

function makeFakeModel(): LanguageModelV3 {
  return {} as unknown as LanguageModelV3;
}

function makeFakeVertex(): GoogleVertexProvider {
  return {
    tools: {
      urlContext: () => ({ type: 'provider-defined' }),
    },
  } as unknown as GoogleVertexProvider;
}

function build(agentId = 'agent-x') {
  return createPageFetcherSubagent({
    geminiFlashLite: makeFakeModel(),
    modelSettings: { maxOutputTokens: 20_000, providerOptions: {} },
    vertex: makeFakeVertex(),
    agentId,
  });
}

describe('createPageFetcherSubagent', () => {
  test('type is `page-fetcher`', () => {
    assert.equal(build().type, 'page-fetcher');
  });

  test('description mentions the JS-rendering caveat so the parent knows when NOT to call', () => {
    const { description } = build();
    assert.match(description, /JS-rendered/);
  });

  test('description directs PDF use to the filesystem view command instead', () => {
    const { description } = build();
    assert.match(description, /filesystem/);
    assert.match(description, /view/);
  });

  test('description tells the parent agent to pass model: gemini-flash-lite', () => {
    // Without explicit guidance the parent fills in SUBAGENT_DEFAULT_MODEL,
    // which `allowedModelOverrides` rejects here — a wasted round-trip.
    const { description } = build();
    assert.match(description, /gemini-flash-lite/);
  });

  test('model is the passed-in stub (no internal model resolution)', () => {
    const model = makeFakeModel();
    const config = createPageFetcherSubagent({
      geminiFlashLite: model,
      modelSettings: { maxOutputTokens: 20_000, providerOptions: {} },
      vertex: makeFakeVertex(),
    });
    assert.equal(config.model, model);
  });

  test('maxModelCalls is 5 (defensive ceiling — happy path is 1 model call)', () => {
    assert.equal(build().maxModelCalls, 5);
  });

  test('allowedModelOverrides pins the subagent to gemini-flash-lite', () => {
    // The non-empty whitelist is what activates the gate in SubagentToolModel.
    // An empty array (`[]`) wouldn't type-check AND wouldn't restrict — the
    // override path would fall through to the parent's allowedModels.
    assert.deepEqual(build().allowedModelOverrides, ['gemini-flash-lite']);
  });

  test('traceName includes the agentId for Langfuse grouping', () => {
    assert.equal(build('abc-123').traceName, 'PageFetcher: abc-123');
  });

  test('traceName falls back to `unknown` when agentId is absent', () => {
    const config = createPageFetcherSubagent({
      geminiFlashLite: makeFakeModel(),
      modelSettings: { maxOutputTokens: 20_000, providerOptions: {} },
      vertex: makeFakeVertex(),
    });
    assert.equal(config.traceName, 'PageFetcher: unknown');
  });

  test('systemPrompt commits to verbatim emission and rejects summarising', () => {
    const { systemPrompt } = build();
    assert.match(systemPrompt, /Do NOT summarise/);
  });

  test('systemPrompt forbids hallucination when grounding silently fails', () => {
    // Without this rule, if Vertex urlContext fails to retrieve a URL the
    // model is left with just the URL string and tends to fabricate content
    // from training data. Verified empirically — this rule is load-bearing.
    const { systemPrompt } = build();
    assert.match(systemPrompt, /Anti-hallucination/);
    assert.match(systemPrompt, /Retrieval can silently fail/);
    assert.match(systemPrompt, /do NOT fabricate/);
  });

  test('toolRegistry contains the url_context wrapper', () => {
    const config = build();
    const tools = config.toolRegistry.getAllTools();
    assert.ok(
      tools.some((t) => t.getName() === 'url_context'),
      'toolRegistry must expose url_context',
    );
  });

  test('toolRegistry contains exactly one tool (no parent inheritance, no extras)', () => {
    const config = build();
    const tools = config.toolRegistry.getAllTools();
    assert.equal(tools.length, 1);
  });
});
