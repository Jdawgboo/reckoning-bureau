import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createRespondentCounselSubagent } from './respondent-counsel-subagent.ts';

function makeFakeModel(): LanguageModelV3 {
  return {} as unknown as LanguageModelV3;
}

describe('createRespondentCounselSubagent', () => {
  test('has an empty tool registry so it cannot retrieve broader case data', () => {
    const config = createRespondentCounselSubagent({ defaultModel: makeFakeModel() });
    assert.equal(config.toolRegistry.getAllTools().length, 0);
  });

  test('uses a one-call ceiling and the configured evidence-only prompt', () => {
    const config = createRespondentCounselSubagent({ defaultModel: makeFakeModel(), agentId: 'rb-test' });
    assert.equal(config.maxModelCalls, 1);
    assert.match(config.systemPrompt, /strength score/);
    assert.match(config.systemPrompt, /exactly one short, direct question/);
    assert.equal(config.traceName, 'RespondentCounsel: rb-test');
  });
});
