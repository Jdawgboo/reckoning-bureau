import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelProvider } from '../../agent/interfaces';
import {
  SUBAGENT_ALLOWED_MODELS,
  SUBAGENT_DEFAULT_MODEL,
  SUBAGENT_MODEL_DESCRIPTION,
  buildSubagentModelResolver,
} from './subagent-model-resolver.ts';

describe('agent subagent model options', () => {
  const models: readonly string[] = SUBAGENT_ALLOWED_MODELS;

  it('defaults to gemini-flash', () => {
    assert.equal(SUBAGENT_DEFAULT_MODEL, 'gemini-flash');
  });

  it('offers the default as a selectable model', () => {
    // Out of the enum, the tool schema warns and falls back to allowedModels[0].
    assert.ok(models.includes(SUBAGENT_DEFAULT_MODEL));
  });

  it('names the default in the description, and names no other', () => {
    assert.match(SUBAGENT_MODEL_DESCRIPTION, /Default: gemini-flash\./);
    assert.doesNotMatch(SUBAGENT_MODEL_DESCRIPTION, /Default: (?!gemini-flash)/);
  });

  it('offers gpt-5-5 and no longer gpt-5-4', () => {
    assert.ok(models.includes('gpt-5-5'), 'gpt-5-5 must be selectable');
    assert.ok(!models.includes('gpt-5-4'), 'gpt-5-4 must be gone');
  });

  it('still lists code-executor-sonnet (only the gpt option changed)', () => {
    assert.ok(models.includes('code-executor-sonnet'));
  });

  it('mentions gpt-5-5 (not gpt-5-4) in the model description', () => {
    assert.match(SUBAGENT_MODEL_DESCRIPTION, /gpt-5-5/);
    assert.doesNotMatch(SUBAGENT_MODEL_DESCRIPTION, /gpt-5-4/);
  });

  it('resolves gpt-5-5 to a model and no longer resolves gpt-5-4', async () => {
    const modelProvider = {
      getModel: async () => ({}) as unknown as LanguageModelV3,
    } as unknown as ModelProvider;

    const resolve = await buildSubagentModelResolver(modelProvider);

    assert.ok(resolve('gpt-5-5'), 'gpt-5-5 must resolve');
    assert.equal(resolve('gpt-5-4'), null, 'gpt-5-4 must no longer resolve');
  });
});
