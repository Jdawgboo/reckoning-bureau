import { describe, it } from 'node:test';
import assert from 'node:assert';
import { applyUiStateUpdate, type UiStateWritable } from './handle-state-update.ts';

function fakeStateTree(): {
  tree: UiStateWritable;
  writes: Array<{ sessionId: string; value: Record<string, unknown> }>;
} {
  const writes: Array<{ sessionId: string; value: Record<string, unknown> }> = [];
  const tree: UiStateWritable = {
    sessions: {
      get(sessionId: string) {
        return {
          uiState: {
            async set(value: Record<string, unknown>) {
              writes.push({ sessionId, value });
            },
          },
        };
      },
    },
  };
  return { tree, writes };
}

describe('applyUiStateUpdate', () => {
  it('writes the value to the session uiState node (latest-wins full replace)', async () => {
    const { tree, writes } = fakeStateTree();

    const result = await applyUiStateUpdate(tree, 'sess-1', { form: { email: 'a@b.c' } });

    assert.deepStrictEqual(result, { accepted: true });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].sessionId, 'sess-1');
    assert.deepStrictEqual(writes[0].value, { form: { email: 'a@b.c' } });
  });

  it('throws on a non-object value', async () => {
    const { tree } = fakeStateTree();
    await assert.rejects(() => applyUiStateUpdate(tree, 's', 'nope'));
    await assert.rejects(() => applyUiStateUpdate(tree, 's', 42));
    await assert.rejects(() => applyUiStateUpdate(tree, 's', ['a']));
    await assert.rejects(() => applyUiStateUpdate(tree, 's', null));
  });

  it('does not write and reports not-accepted when the state layer is absent (degraded)', async () => {
    const result = await applyUiStateUpdate(null, 'sess-1', { a: 1 });
    assert.deepStrictEqual(result, { accepted: false });
  });
});
