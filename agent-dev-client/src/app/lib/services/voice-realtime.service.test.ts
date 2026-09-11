import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  VoiceRealtimePlaybackQueue,
  type VoiceRealtimePlaybackSource,
} from './voice-realtime-playback-queue.ts';

class FakeSource implements VoiceRealtimePlaybackSource {
  stops = 0;

  stop(): void {
    this.stops += 1;
  }
}

describe('VoiceRealtimePlaybackQueue', () => {
  it('acknowledges an item only after input and every source are complete', () => {
    const completed: string[] = [];
    const queue = new VoiceRealtimePlaybackQueue((itemId) => completed.push(itemId));
    const first = new FakeSource();
    const second = new FakeSource();
    queue.enqueue('item-1', 0, 1, 1.5, first);
    queue.enqueue('item-1', 0, 1.5, 2, second);

    queue.markInputDone('item-1');
    queue.sourceEnded('item-1', first);
    assert.deepStrictEqual(completed, []);

    queue.sourceEnded('item-1', second);
    queue.sourceEnded('item-1', second);
    assert.deepStrictEqual(completed, ['item-1']);
    assert.strictEqual(queue.hasPlayback(), false);
  });

  it('classifies completed, current, and queued items independently on barge-in', () => {
    const completed: string[] = [];
    const queue = new VoiceRealtimePlaybackQueue((itemId) => completed.push(itemId));
    const finished = new FakeSource();
    const current = new FakeSource();
    const queued = new FakeSource();
    queue.enqueue('finished', 0, 0, 1, finished);
    queue.markInputDone('finished');
    queue.enqueue('current', 1, 1, 3, current);
    queue.enqueue('queued', 2, 3, 4, queued);

    const interruption = queue.clear(2.25);

    assert.deepStrictEqual(interruption, {
      completedItemIds: ['finished'],
      truncations: [
        { itemId: 'current', contentIndex: 1, audioEndMs: 1_250 },
        { itemId: 'queued', contentIndex: 2, audioEndMs: 0 },
      ],
    });
    assert.deepStrictEqual(completed, []);
    assert.strictEqual(finished.stops, 1);
    assert.strictEqual(current.stops, 1);
    assert.strictEqual(queued.stops, 1);
    assert.strictEqual(queue.hasPlayback(), false);
  });

  it('does not acknowledge a stopped source through a late onended callback', () => {
    const completed: string[] = [];
    const queue = new VoiceRealtimePlaybackQueue((itemId) => completed.push(itemId));
    const source = new FakeSource();
    queue.enqueue('interrupted', 0, 1, 2, source);
    queue.markInputDone('interrupted');

    queue.clear(1.5);
    queue.sourceEnded('interrupted', source);

    assert.deepStrictEqual(completed, []);
  });
});
