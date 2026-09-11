import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import type { KernelModelMiddleware } from '../../../vendor/agent-library/kernel/middlewares/types.ts';
import type AgentState from '../../../vendor/agent-library/core/agent-state.ts';
import { appendToLastUserMessage, createUiStateMiddleware } from './ui-state-middleware.ts';

/** `KernelModelMiddleware.create()` is typed to allow an array/null result;
 *  this middleware always returns a single object — narrow that for tests.
 *  `state` is unused by this middleware, so an empty stub is enough. */
function createSingle(middleware: KernelModelMiddleware): LanguageModelMiddleware {
  const created = middleware.create({ state: {} as unknown as AgentState });
  if (!created || Array.isArray(created)) {
    throw new Error('expected a single LanguageModelMiddleware');
  }
  return created;
}

function fixturePrompt(): LanguageModelV3Message[] {
  return [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    },
    { role: 'user', content: [{ type: 'text', text: 'book me a slot' }] },
  ];
}

describe('appendToLastUserMessage', () => {
  it('appends the block to the last user message text, immutably', () => {
    const prompt = fixturePrompt();
    const originalPrompt = structuredClone(prompt);

    const result = appendToLastUserMessage(prompt, '<ui_state>{"a":1}</ui_state>');

    assert.deepStrictEqual(prompt, originalPrompt); // input untouched
    const lastUser = result[3] as Extract<LanguageModelV3Message, { role: 'user' }>;
    assert.deepStrictEqual(lastUser.content, [
      { type: 'text', text: 'book me a slot\n\n<ui_state>{"a":1}</ui_state>' },
    ]);
    // earlier messages unchanged (same reference — no needless cloning)
    assert.strictEqual(result[0], prompt[0]);
    assert.strictEqual(result[1], prompt[1]);
    assert.strictEqual(result[2], prompt[2]);
  });

  it('is a no-op when the block is empty', () => {
    const prompt = fixturePrompt();
    const result = appendToLastUserMessage(prompt, '');
    assert.strictEqual(result, prompt);
  });

  it('is a no-op when there is no user message', () => {
    const prompt: LanguageModelV3Message[] = [{ role: 'system', content: 'be helpful' }];
    const result = appendToLastUserMessage(prompt, '<ui_state>{}</ui_state>');
    assert.strictEqual(result, prompt);
  });
});

describe('createUiStateMiddleware', () => {
  it('appends to the last user message when the block is non-empty', async () => {
    const middleware = createUiStateMiddleware(async () => '<ui_state>{"x":2}</ui_state>');
    const languageModelMiddleware = createSingle(middleware);
    if (!languageModelMiddleware.transformParams) {
      throw new Error('transformParams missing');
    }

    const params = {
      prompt: fixturePrompt(),
    } as unknown as LanguageModelV3CallOptions;
    const originalParams = structuredClone(params);

    const transformed = (await languageModelMiddleware.transformParams({
      params,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture, unused by transformParams
    } as any)) as LanguageModelV3CallOptions;

    assert.deepStrictEqual(params, originalParams); // params object not mutated
    const lastUser = transformed.prompt[3] as Extract<LanguageModelV3Message, { role: 'user' }>;
    assert.deepStrictEqual(lastUser.content, [
      { type: 'text', text: 'book me a slot\n\n<ui_state>{"x":2}</ui_state>' },
    ]);
  });

  it('is a no-op when the block is empty', async () => {
    const middleware = createUiStateMiddleware(async () => '');
    const languageModelMiddleware = createSingle(middleware);
    if (!languageModelMiddleware.transformParams) {
      throw new Error('transformParams missing');
    }

    const params = { prompt: fixturePrompt() } as unknown as LanguageModelV3CallOptions;
    const transformed = (await languageModelMiddleware.transformParams({
      params,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture, unused by transformParams
    } as any)) as LanguageModelV3CallOptions;

    assert.deepStrictEqual(transformed.prompt, params.prompt);
  });
});
