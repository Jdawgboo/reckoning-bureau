/**
 * Injectable scheduling, so code with minute-scale timers stays testable at
 * microsecond scale. Every timer in this library goes through this rather than
 * calling `setTimeout` directly: a session cap measured in minutes is otherwise
 * only exercisable by a test that waits minutes, which means it is never
 * exercised.
 */

/** Cancels a scheduled callback. Cancelling twice, or after it fired, is a no-op. */
export interface VoiceTimerHandle {
  cancel(): void;
}

export type ScheduleVoiceTimer = (callback: () => void, delayMs: number) => VoiceTimerHandle;

/** `unref` so a pending timer never holds a process open past its real work. */
export const scheduleVoiceTimer: ScheduleVoiceTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};
