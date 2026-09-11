import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveContextPlan } from './model-context-plan.ts';

describe('resolveContextPlan', () => {
  it('unknown model falls back to legacy 200k/160k', () => {
    assert.deepStrictEqual(resolveContextPlan('some-unknown-model'), {
      contextBudgetTokens: 200_000,
      triggerTokens: 160_000,
      keepRecentTokens: 30_000,
    });
  });

  it('1M-window claude models cap at 350k budget / 200k trigger', () => {
    assert.deepStrictEqual(resolveContextPlan('claude-sonnet-5'), {
      contextBudgetTokens: 350_000,
      triggerTokens: 200_000,
      keepRecentTokens: 30_000,
    });
    assert.strictEqual(
      resolveContextPlan('global.anthropic.claude-sonnet-5').contextBudgetTokens,
      350_000,
    );
  });

  it('claude-opus-4-5 keeps its 200k window with 0.75/50k policy', () => {
    assert.deepStrictEqual(resolveContextPlan('claude-opus-4-5'), {
      contextBudgetTokens: 200_000,
      triggerTokens: 150_000,
      keepRecentTokens: 30_000,
    });
  });

  it('gemini models use the 1_048_576 window (capped) with 100k reserve', () => {
    const plan = resolveContextPlan('gemini-3.5-flash');
    assert.strictEqual(plan.contextBudgetTokens, 350_000);
    assert.strictEqual(plan.triggerTokens, 200_000);
  });

  it('gpt models get 200k window with 40k reserve → 160k trigger', () => {
    assert.strictEqual(resolveContextPlan('gpt-5.4').triggerTokens, 160_000);
  });

  it('grok gets its 256k window and the 200k trigger cap', () => {
    const plan = resolveContextPlan('grok-4.3');
    assert.strictEqual(plan.contextBudgetTokens, 256_000);
    assert.strictEqual(plan.triggerTokens, 200_000);
  });
});
