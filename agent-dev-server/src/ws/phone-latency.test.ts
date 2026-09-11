import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PhoneLatencyTracker } from './phone-latency.ts';

function trackerAt(clock: { t: number }) {
  const lines: Record<string, unknown>[] = [];
  const tracker = new PhoneLatencyTracker({
    sessionKey: 'phone:+15550100',
    now: () => clock.t,
    emit: (line) => lines.push(line),
  });
  return { tracker, lines };
}

describe('PhoneLatencyTracker', () => {
  it('measures the whole fast path of one forwarded turn', () => {
    const clock = { t: 1_000 };
    const { tracker, lines } = trackerAt(clock);

    tracker.noteSpeechStopped();
    clock.t = 1_400;
    const forward = tracker.beginForward();
    forward.attach('run-1');
    clock.t = 3_900;
    tracker.noteFirstContent('run-1');
    clock.t = 5_100;
    tracker.noteTurnEnded('run-1');
    clock.t = 5_200;
    tracker.noteRelayScheduled('run-1');

    assert.deepStrictEqual(lines, [
      {
        sessionKey: 'phone:+15550100',
        responseId: 'run-1',
        speechEndToForwardMs: 400,
        forwardToFirstContentMs: 2_500,
        forwardToTurnEndMs: 3_700,
        forwardToRelayMs: 3_800,
        spoken: true,
      },
    ]);
  });

  it('emits exactly one line per turn', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.beginForward().attach('run-1');
    tracker.noteRelayScheduled('run-1');
    tracker.noteRelayScheduled('run-1');
    tracker.flushAll();
    assert.strictEqual(lines.length, 1);
  });

  it('keeps the first content timestamp, not the last', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.beginForward().attach('run-1');
    clock.t = 700;
    tracker.noteFirstContent('run-1');
    clock.t = 4_000;
    tracker.noteFirstContent('run-1');
    tracker.noteRelayScheduled('run-1');
    assert.strictEqual(lines[0]?.['forwardToFirstContentMs'], 700);
  });

  it('omits speech-end when the turn was not started by speech', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.beginForward().attach('run-1');
    tracker.noteRelayScheduled('run-1');
    assert.strictEqual('speechEndToForwardMs' in (lines[0] ?? {}), false);
  });

  it('never measures a turn from a previous turn stale speech end', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.noteSpeechStopped();
    clock.t = 100;
    tracker.beginForward().attach('run-1');
    tracker.noteRelayScheduled('run-1');
    clock.t = 9_000;
    tracker.beginForward().attach('run-2');
    tracker.noteRelayScheduled('run-2');

    assert.strictEqual(lines[0]?.['speechEndToForwardMs'], 100);
    assert.strictEqual('speechEndToForwardMs' in (lines[1] ?? {}), false);
  });

  it('reports a turn that never reached the caller, on close', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.beginForward().attach('run-1');
    clock.t = 2_000;
    tracker.noteTurnEnded('run-1');
    tracker.flushAll();

    assert.deepStrictEqual(lines, [
      {
        sessionKey: 'phone:+15550100',
        responseId: 'run-1',
        forwardToTurnEndMs: 2_000,
        spoken: false,
      },
    ]);
  });

  it('ignores runs it never saw forwarded — screen-origin turns are not calls', () => {
    const clock = { t: 0 };
    const { tracker, lines } = trackerAt(clock);
    tracker.noteFirstContent('screen-run');
    tracker.noteTurnEnded('screen-run');
    tracker.noteRelayScheduled('screen-run');
    tracker.flushAll();
    assert.deepStrictEqual(lines, []);
  });
});
