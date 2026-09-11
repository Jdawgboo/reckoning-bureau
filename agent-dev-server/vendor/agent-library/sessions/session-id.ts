/**
 * The single session-id contract.
 *
 * A session id is not just a label: the same string is interpolated into a
 * state path (`/sessions/{id}/messages/{seq}`), a DynamoDB sort key
 * (`MSG#{id}#{seq}`), and an S3 folder name. Before AGE-472 each of those
 * boundaries grew its own validation rule, so an id could be accepted by one
 * writer and rejected — or silently misfiled — by the next.
 *
 * The pattern below is deliberately permissive enough for every id the platform
 * already mints (`role:{id}:standing`, dashboard UUIDs, `cron-{task}-{evt}`)
 * and strict enough that an id can never introduce a new path segment: `/` and
 * `\` are illegal, and so is a leading separator character.
 */

/** Legal session ids: start alphanumeric, then alphanumerics plus `_ . : -`. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Upper bound on a session id, matching the state-tree identifier ceiling. */
export const MAX_SESSION_ID_LENGTH = 128;

const FIRST_CHAR_PATTERN = /^[A-Za-z0-9]$/;
const ALLOWED_CHAR_PATTERN = /^[A-Za-z0-9_.:-]$/;

/** True when `value` satisfies the session-id contract. */
export function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  );
}

/**
 * Describe why `value` is not a legal session id, or `null` when it is legal.
 *
 * The message names the offending character so a rejection is actionable at the
 * boundary that produced it — `illegal sessionId "cron/a/run-b": contains "/"`
 * rather than a generic "unsupported path".
 */
export function describeSessionIdViolation(value: unknown, label = 'sessionId'): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `illegal ${label}: must be a non-empty string`;
  }
  if (value.length > MAX_SESSION_ID_LENGTH) {
    return `illegal ${label} ${JSON.stringify(value)}: exceeds the maximum length of ${MAX_SESSION_ID_LENGTH}`;
  }
  if (SESSION_ID_PATTERN.test(value)) {
    return null;
  }
  const illegalChar = [...value].find((char) => !ALLOWED_CHAR_PATTERN.test(char));
  if (illegalChar !== undefined) {
    return `illegal ${label} ${JSON.stringify(value)}: contains ${JSON.stringify(illegalChar)}`;
  }
  if (!FIRST_CHAR_PATTERN.test(value[0])) {
    return `illegal ${label} ${JSON.stringify(value)}: must start with a letter or digit`;
  }
  return `illegal ${label} ${JSON.stringify(value)}: does not match ${SESSION_ID_PATTERN.source}`;
}
