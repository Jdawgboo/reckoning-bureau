import { setVoiceLogger, type VoiceLogger } from '../util/logger.ts';

export interface CapturedAlarm {
  level: 'warn' | 'error';
  message: string;
  meta: Record<string, unknown> | undefined;
}

export interface AlarmCapture {
  /** Marks alarms matching `pattern` as expected by this test; returns how many matched so far. */
  expect(pattern: RegExp): void;
  /** Alarms no `expect()` claimed — a passing scenario must leave this empty. */
  unexpected(): CapturedAlarm[];
  restore(): void;
}

/**
 * Routes the library logger into a recorder so scenarios FAIL on alarms they
 * did not declare. Exists because this library's worst live defects were
 * log-only: behavior stayed correct, history stayed correct, and one lying
 * `warn` (later surfaced to users as a runtime error) was the entire symptom —
 * invisible to every behavioral assertion. `debug`/`info` stay unrecorded;
 * they are narration, not alarms.
 */
export function captureVoiceAlarms(): AlarmCapture {
  const alarms: CapturedAlarm[] = [];
  const expected: RegExp[] = [];
  const recorder: VoiceLogger = {
    debug: () => {},
    info: () => {},
    warn: (message, meta) => alarms.push({ level: 'warn', message, meta }),
    error: (message, meta) => alarms.push({ level: 'error', message, meta }),
  };
  setVoiceLogger(recorder);
  return {
    expect(pattern: RegExp): void {
      expected.push(pattern);
    },
    unexpected(): CapturedAlarm[] {
      return alarms.filter((alarm) => !expected.some((pattern) => pattern.test(alarm.message)));
    },
    restore(): void {
      setVoiceLogger(console);
    },
  };
}
