import assert from 'node:assert';
import { describe, it } from 'node:test';
import { VoiceScreenSelectionTracker } from './voice-screen-selection.ts';

describe('VoiceScreenSelectionTracker', () => {
  it('puts the latest pre-activation selection on the activation frame', () => {
    const tracker = new VoiceScreenSelectionTracker(null);
    assert.strictEqual(tracker.update({ kind: 'surface', surfaceId: 'surface-2' }), null);
    assert.deepStrictEqual(tracker.activate(), {
      type: 'voice.activate',
      screen: { kind: 'surface', surfaceId: 'surface-2' },
    });
  });

  it('emits only changed selections after activation', () => {
    const tracker = new VoiceScreenSelectionTracker({
      kind: 'surface',
      surfaceId: 'surface-1',
    });
    tracker.activate();
    assert.strictEqual(tracker.update({ kind: 'surface', surfaceId: 'surface-1' }), null);
    assert.deepStrictEqual(tracker.update({ kind: 'surface', surfaceId: 'surface-2' }), {
      type: 'voice.screen',
      screen: { kind: 'surface', surfaceId: 'surface-2' },
    });
    assert.deepStrictEqual(tracker.update({ kind: 'text', text: 'Visible answer' }), {
      type: 'voice.screen',
      screen: { kind: 'text', text: 'Visible answer' },
    });
    assert.deepStrictEqual(tracker.update(null), { type: 'voice.screen', screen: null });
  });
});
