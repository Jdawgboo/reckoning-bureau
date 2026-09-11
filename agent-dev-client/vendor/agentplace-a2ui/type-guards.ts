/** Shared structural guards for A2UI payloads, which arrive untyped from the model. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
