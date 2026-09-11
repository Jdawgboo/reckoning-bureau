/**
 * Tests for the shared a2ui action helpers. They live here rather than beside their source
 * because `agentplace-a2ui` has no test runner of its own.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  collectCheckedNodes,
  readActionEvent,
  resolveActionContext,
} from '../../vendor/agentplace-a2ui/actions.ts';
import type { ResolvedNode } from '../../vendor/agentplace-a2ui/walker.ts';

function node(
  id: string,
  props: Record<string, unknown> = {},
  children: ResolvedNode[] = [],
): ResolvedNode {
  return {
    id,
    component: 'Test',
    known: true,
    props,
    children,
    danglingChildIds: [],
    bindings: {},
  };
}

describe('readActionEvent', () => {
  it('reads name and context', () => {
    assert.deepStrictEqual(readActionEvent({ event: { name: 'go', context: { a: 1 } } }), {
      name: 'go',
      context: { a: 1 },
    });
  });

  it('omits a non-record context rather than passing it on', () => {
    assert.deepStrictEqual(readActionEvent({ event: { name: 'go', context: 'nope' } }), {
      name: 'go',
      context: undefined,
    });
  });

  it('rejects malformed input', () => {
    assert.strictEqual(readActionEvent(undefined), null);
    assert.strictEqual(readActionEvent({}), null);
    assert.strictEqual(readActionEvent({ event: {} }), null);
    assert.strictEqual(readActionEvent({ event: { name: 42 } }), null);
    assert.strictEqual(readActionEvent('go'), null);
  });
});

describe('collectCheckedNodes', () => {
  it('collects only nodes whose checks are an array, including the root', () => {
    const tree = node('root', { checks: [] }, [
      node('a', { checks: 'nope' }),
      node('b', { checks: [{ call: 'required' }] }),
    ]);

    const out: ResolvedNode[] = [];
    collectCheckedNodes(tree, out);

    assert.deepStrictEqual(
      out.map((n) => n.id),
      ['root', 'b'],
    );
  });
});

describe('resolveActionContext', () => {
  it('reads bound paths through the injected reader and passes literals through', () => {
    const read = (pointer: string) => ({ '/form/email': 'a@b.c' })[pointer];

    assert.deepStrictEqual(
      resolveActionContext({ email: { path: '/form/email' }, plan: 'pro', count: 2 }, read),
      { email: 'a@b.c', plan: 'pro', count: 2 },
    );
  });

  it('yields undefined for a path the reader does not know', () => {
    assert.deepStrictEqual(
      resolveActionContext({ email: { path: '/missing' } }, () => undefined),
      {
        email: undefined,
      },
    );
  });

  it('treats a record without a string path as a literal', () => {
    const value = { path: 42 };

    assert.deepStrictEqual(
      resolveActionContext({ odd: value }, () => 'read'),
      { odd: value },
    );
  });

  it('yields an empty object for an absent context', () => {
    assert.deepStrictEqual(
      resolveActionContext(undefined, () => 'read'),
      {},
    );
  });
});
