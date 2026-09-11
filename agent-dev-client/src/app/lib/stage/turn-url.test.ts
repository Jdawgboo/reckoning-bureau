import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatTurnFragment, parseTurnFragment, resolveHistoryAction } from './turn-url.ts';

describe('parseTurnFragment', () => {
  const cases: Array<[string, number | null]> = [
    ['#3', 2],
    ['#2', 1],
    ['#1', 0],
    ['#10', 9],
    ['', null],
    ['#', null],
    ['#abc', null],
    ['#0', null],
    ['#-1', null],
    ['#1.5', null],
    ['#03', null],
    ['#3x', null],
  ];
  for (const [hash, expected] of cases) {
    it(`${JSON.stringify(hash)} → ${expected}`, () => {
      assert.strictEqual(parseTurnFragment(hash), expected);
    });
  }
});

describe('formatTurnFragment', () => {
  it('index 0 (home) has no fragment', () => {
    assert.strictEqual(formatTurnFragment(0), '');
  });
  it('index N ≥ 1 renders 1-based', () => {
    assert.strictEqual(formatTurnFragment(1), '#2');
    assert.strictEqual(formatTurnFragment(2), '#3');
  });
});

describe('resolveHistoryAction', () => {
  it('aligned → none (also preserves Forward after popstate)', () => {
    assert.strictEqual(
      resolveHistoryAction({ urlIndex: 2, shownIndex: 2, fromPopstate: false }),
      'none',
    );
    assert.strictEqual(
      resolveHistoryAction({ urlIndex: 2, shownIndex: 2, fromPopstate: true }),
      'none',
    );
  });

  it('first sync of the load → replace', () => {
    assert.strictEqual(
      resolveHistoryAction({ urlIndex: undefined, shownIndex: 0, fromPopstate: false }),
      'replace',
    );
  });

  it('popstate landing off-target (clamped stale index) → replace', () => {
    assert.strictEqual(
      resolveHistoryAction({ urlIndex: 9, shownIndex: 4, fromPopstate: true }),
      'replace',
    );
  });

  it('genuine navigation (new turn, rail pick) → push', () => {
    assert.strictEqual(
      resolveHistoryAction({ urlIndex: 1, shownIndex: 2, fromPopstate: false }),
      'push',
    );
  });

  it('send → new turn arrival is exactly one push', () => {
    const actions = [
      resolveHistoryAction({ urlIndex: 2, shownIndex: 2, fromPopstate: false }),
      resolveHistoryAction({ urlIndex: 2, shownIndex: 3, fromPopstate: false }),
      resolveHistoryAction({ urlIndex: 3, shownIndex: 3, fromPopstate: false }),
    ];
    assert.deepStrictEqual(actions, ['none', 'push', 'none']);
  });
});
