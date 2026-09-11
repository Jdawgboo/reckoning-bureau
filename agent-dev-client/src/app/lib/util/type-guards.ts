/**
 * Shared runtime type guards for agent-dev-client. Import from here rather
 * than re-declaring `isRecord`/etc. locally.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
