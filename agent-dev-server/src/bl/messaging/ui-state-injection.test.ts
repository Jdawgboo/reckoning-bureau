import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  formatUiStateBlock,
  readUiStateBlock,
  type UiStateReadable,
} from './ui-state-injection.ts';

describe('formatUiStateBlock', () => {
  it('renders a delimited, key-sorted block for a non-empty state', () => {
    const block = formatUiStateBlock({ b: 2, a: { y: 1, x: 2 } });
    assert.ok(block.startsWith('<ui_state>\n'));
    assert.ok(block.includes('</ui_state>'));
    // keys sorted deeply → deterministic regardless of insertion order
    assert.ok(block.includes('{"a":{"x":2,"y":1},"b":2}'));
  });

  it('returns empty string for empty / non-object state', () => {
    assert.strictEqual(formatUiStateBlock({}), '');
    assert.strictEqual(formatUiStateBlock(null), '');
    assert.strictEqual(formatUiStateBlock('nope'), '');
    assert.strictEqual(formatUiStateBlock(['a']), '');
  });

  it('truncates an oversized state', () => {
    const big = { blob: 'x'.repeat(10_000) };
    const block = formatUiStateBlock(big);
    assert.ok(block.includes('(truncated)'));
    assert.ok(block.length < 4300);
  });
});

describe('readUiStateBlock', () => {
  function fakeTree(value: unknown): UiStateReadable {
    return { get: async (path: string) => (path.endsWith('/uiState') ? value : null) };
  }

  it('reads the session uiState node and formats it', async () => {
    const block = await readUiStateBlock(fakeTree({ form: { email: 'a@b.c' } }), 'sess-1');
    assert.ok(block.includes('<ui_state>'));
    assert.ok(block.includes('"email":"a@b.c"'));
  });

  it('returns empty when there is no state layer or no sessionKey', async () => {
    assert.strictEqual(await readUiStateBlock(null, 'sess-1'), '');
    assert.strictEqual(await readUiStateBlock(fakeTree({ a: 1 }), undefined), '');
  });

  it('returns empty when the node value is empty', async () => {
    assert.strictEqual(await readUiStateBlock(fakeTree({}), 'sess-1'), '');
    assert.strictEqual(await readUiStateBlock(fakeTree(null), 'sess-1'), '');
  });

  it('swallows a read error and injects nothing', async () => {
    const throwingTree: UiStateReadable = {
      get: async () => {
        throw new Error('backend down');
      },
    };
    assert.strictEqual(await readUiStateBlock(throwingTree, 'sess-1'), '');
  });
});
