/**
 * Shared runtime type guards for agent-dev-server. Import from here rather than
 * re-declaring `isRecord`/etc. locally (the most-duplicated helpers).
 */
import type { MemoryEntry } from '../types.ts';

/** Narrows `unknown` to a plain object so its keys can be safely bracket-accessed. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is an array containing only strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** True when `value` is an array of wire-shaped memory entries (id/summary/timestamp). */
export function isMemoryEntryArray(value: unknown): value is MemoryEntry[] {
  return Array.isArray(value) && value.every(isMemoryEntry);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['timestamp'] === 'number'
  );
}
