const MS_PER_MINUTE = 60_000;

/**
 * Renders the age of `timestampMs` relative to `nowMs` as a short,
 * model-facing phrase (e.g. `"3 weeks ago"`), for use in memory-bank
 * prompts so the model can discount stale notes. `nowMs` is an explicit
 * param rather than an internal clock read so callers — and their tests —
 * stay deterministic. A `timestampMs` in the future (clock skew) clamps to
 * `'just now'` rather than going negative.
 */
export function formatRelativeAge(timestampMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(deltaMs / MS_PER_MINUTE);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return pluralize(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return pluralize(hours, 'hour');
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return pluralize(days, 'day');
  }
  if (days < 30) {
    return pluralize(Math.floor(days / 7), 'week');
  }
  return pluralize(Math.floor(days / 30), 'month');
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
