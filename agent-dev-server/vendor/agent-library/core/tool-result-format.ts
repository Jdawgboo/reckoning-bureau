import { getAgentLogger } from '../types/logger.ts';

/** Integer literal in value position long enough to exceed Number.MAX_SAFE_INTEGER (2^53). */
const UNSAFE_INT_LITERAL = /[:,[]\s*-?\d{16,}\s*(?=[,}\]])/;

/**
 * Pretty-print a single-line JSON object/array tool result before storage so
 * line-oriented consumers (Grep, viewRanges, previews) work per record.
 * Anything else (text, invalid JSON, scalars) is returned unchanged, as are
 * payloads with integers above 2^53 — a parse round-trip would corrupt them.
 * Duplicate keys collapse to the last value (accepted risk).
 */
export function formatToolResultForStorage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }

  if (UNSAFE_INT_LITERAL.test(trimmed)) {
    getAgentLogger().error(
      '[ToolResultFormat] Skipped pretty-print: integer literal above Number.MAX_SAFE_INTEGER would lose precision in a parse round-trip',
      { contentLength: raw.length },
    );
    return raw;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}
