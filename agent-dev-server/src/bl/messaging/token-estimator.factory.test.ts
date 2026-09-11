import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTokenEstimator } from './token-estimator.factory.ts';
import { AnthropicCountTokensEstimator } from '../../../vendor/agent-library/util/anthropic-count-tokens.estimator.ts';
import { GeminiCountTokensEstimator } from '../../../vendor/agent-library/util/gemini-count-tokens.estimator.ts';
import { OpenAICountTokensEstimator } from '../../../vendor/agent-library/util/openai-count-tokens.estimator.ts';
import { HeuristicTokenEstimator } from '../../../vendor/agent-library/util/token-estimator.ts';

const CFG = { gatewayBaseUrl: 'https://gw.test/api/gateway', accessKey: 'k' };

describe('createTokenEstimator — family mapping', () => {
  it('claude → Anthropic estimator', () => {
    assert.ok(
      createTokenEstimator('claude-sonnet-5', CFG) instanceof AnthropicCountTokensEstimator,
    );
  });
  it('global.anthropic → Anthropic estimator (Bedrock CountTokens does not cover all Claude models)', () => {
    assert.ok(
      createTokenEstimator('global.anthropic.claude-sonnet-5', CFG) instanceof
        AnthropicCountTokensEstimator,
    );
  });

  it('bedrock-hosted model counts via the anthropic endpoint with the mapped model id', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ input_tokens: 8 }), { status: 200 });
    }) as typeof fetch;

    const estimator = createTokenEstimator('global.anthropic.claude-sonnet-5', {
      ...CFG,
      fetchFn,
    });
    const result = await estimator.estimate(
      { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      'global.anthropic.claude-sonnet-5',
      'amazon-bedrock',
    );

    assert.strictEqual(result.tokens, 8);
    assert.strictEqual(result.estimator, 'anthropic-count-tokens');
    assert.strictEqual(
      calls[0].url,
      'https://gw.test/api/gateway/anthropic/v1/messages/count_tokens',
    );
    assert.strictEqual(JSON.parse(calls[0].body).model, 'claude-sonnet-5');
  });
  it('gemini → Gemini estimator', () => {
    assert.ok(createTokenEstimator('gemini-3.5-flash', CFG) instanceof GeminiCountTokensEstimator);
  });
  it('gpt → OpenAI estimator', () => {
    assert.ok(createTokenEstimator('gpt-5.4', CFG) instanceof OpenAICountTokensEstimator);
  });
  it('grok, openrouter, unknown → heuristic', () => {
    assert.ok(createTokenEstimator('grok-4.3', CFG) instanceof HeuristicTokenEstimator);
    assert.ok(createTokenEstimator('openrouter:foo/bar', CFG) instanceof HeuristicTokenEstimator);
    assert.ok(createTokenEstimator('mystery-model', CFG) instanceof HeuristicTokenEstimator);
  });
});

describe('gateway count-tokens client', () => {
  it('POSTs to the anthropic count_tokens endpoint with X-Access-Key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ input_tokens: 42 }), { status: 200 });
    }) as typeof fetch;

    const { anthropicClient } = await import('./token-estimator.factory.ts');
    const client = anthropicClient(CFG.gatewayBaseUrl, CFG.accessKey, fetchFn);
    const result = await client.countTokens({ model: 'claude-sonnet-5', messages: [] });

    assert.strictEqual(result.input_tokens, 42);
    assert.strictEqual(
      calls[0].url,
      'https://gw.test/api/gateway/anthropic/v1/messages/count_tokens',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    assert.strictEqual(headers['X-Access-Key'], 'k');
  });

  it('throws on non-200 so the estimator falls back to heuristic', async () => {
    const fetchFn = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const { anthropicClient } = await import('./token-estimator.factory.ts');
    const client = anthropicClient(CFG.gatewayBaseUrl, CFG.accessKey, fetchFn);
    await assert.rejects(() => client.countTokens({ model: 'm', messages: [] }));
  });
});
