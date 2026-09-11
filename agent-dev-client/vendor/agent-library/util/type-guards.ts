/**
 * Shared narrowing guards for `unknown` values. Import from here instead of
 * re-declaring locals — see AGENTS.md "Shared type guards".
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
