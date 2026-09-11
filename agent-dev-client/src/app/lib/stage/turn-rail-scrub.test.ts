import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { nearestIndexByY, nearestRailRowByY, type RailRowPosition } from './rail-scrub.ts';

test('nearestIndexByY picks the row whose center is closest', () => {
  const centers = [100, 130, 160, 190];
  assert.equal(nearestIndexByY(centers, 95), 0);
  assert.equal(nearestIndexByY(centers, 147), 2); // 17 from 130, 13 from 160
  assert.equal(nearestIndexByY(centers, 131), 1);
});

test('nearestIndexByY handles edges and empty', () => {
  assert.equal(nearestIndexByY([], 100), -1);
  assert.equal(nearestIndexByY([50], 900), 0);
});

test('nearestRailRowByY preserves the identity of the measured DOM row', () => {
  const rows: RailRowPosition[] = [
    { turnId: 'turn-a', turnIndex: 12, centerY: 100 },
    { turnId: 'turn-b', turnIndex: 13, centerY: 130 },
    { turnId: 'turn-c', turnIndex: 14, centerY: 160 },
  ];

  assert.deepEqual(nearestRailRowByY(rows, 151), rows[2]);
  assert.equal(nearestRailRowByY([], 151), undefined);
});
