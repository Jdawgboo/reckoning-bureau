import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatA2uiActionBlock } from './a2ui-action-block.ts';

describe('formatA2uiActionBlock', () => {
  test('formats a screen action as a self-describing block', () => {
    const block = formatA2uiActionBlock({
      surfaceId: 's1',
      name: 'confirmBooking',
      context: { slot: '10:30' },
    });
    assert.ok(block.startsWith('<ui_action>'));
    assert.ok(block.includes('"confirmBooking"'));
    assert.ok(block.includes('</ui_action>'));
    assert.ok(block.includes('trusted structured event'));
  });

  test('returns empty for absent or non-object values', () => {
    assert.equal(formatA2uiActionBlock(undefined), '');
    assert.equal(formatA2uiActionBlock('click'), '');
    assert.equal(formatA2uiActionBlock(null), '');
  });
});
