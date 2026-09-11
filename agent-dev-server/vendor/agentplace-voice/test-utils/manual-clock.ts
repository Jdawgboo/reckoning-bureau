/**
 * A clock and timer the test drives by hand.
 *
 * Rotation is entirely about minute-scale deadlines — an 8-minute cap, a
 * 90-second pre-arm, a bounded boundary wait — so without this the behaviour is
 * only reachable by a suite that waits minutes, which means it is never
 * exercised. `advance` runs due timers in scheduled order and moves `now` with
 * them, so `Date.now()`-derived arithmetic inside the code under test stays
 * consistent with the timers that fired.
 */

import type { ScheduleVoiceTimer, VoiceTimerHandle } from '../util/timers.ts';

interface ScheduledTimer {
  seq: number;
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
}

export class ManualClock {
  #now: number;
  #seq = 0;
  #timers: ScheduledTimer[] = [];

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now = (): number => this.#now;

  schedule: ScheduleVoiceTimer = (callback, delayMs): VoiceTimerHandle => {
    this.#seq += 1;
    const timer: ScheduledTimer = {
      seq: this.#seq,
      dueAt: this.#now + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };

  /**
   * Move time forward, firing everything due. Timers scheduled by a callback are
   * eligible within the same advance if they fall inside the window, which is what
   * a real event loop would do.
   */
  advance(ms: number): void {
    const target = this.#now + ms;
    while (true) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
      if (!due) {
        break;
      }
      this.#timers = this.#timers.filter((timer) => timer !== due);
      this.#now = Math.max(this.#now, due.dueAt);
      due.callback();
    }
    this.#now = target;
  }

  /** Timers still scheduled and not cancelled. */
  pending(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }
}

/** Lets queued microtasks (an `await`ed `open`, a resolved `speak`) run to completion. */
export function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
