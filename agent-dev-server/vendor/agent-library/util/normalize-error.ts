/**
 * Coerce an arbitrary thrown value into a real Error so:
 * - Winston serializers see a stack and message
 * - sentry-winston's `Object.values(info).find(v => v instanceof Error)` succeeds
 * - Sentry groups by a stable, bounded title instead of `[object Object]`
 *
 * The 500-char bound prevents huge SDK payloads (xAI/OpenRouter/Bedrock JSON
 * error bodies) from producing high-cardinality Sentry fingerprints.
 */
export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error.slice(0, 500));
  }
  try {
    const json = JSON.stringify(error);
    return new Error(typeof json === 'string' ? json.slice(0, 500) : String(error).slice(0, 500));
  } catch {
    return new Error(String(error).slice(0, 500));
  }
}
