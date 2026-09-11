/**
 * Shared runtime type guards for this library. Import these instead of
 * re-declaring local copies (see AGENTS.md → "Shared type guards").
 */

/** Narrows `unknown` to a plain object so its keys can be safely bracket-accessed. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
