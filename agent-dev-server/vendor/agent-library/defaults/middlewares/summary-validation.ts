import { gzipSync } from 'node:zlib';

const WRAPPER_TAGS = ['<compaction-summary>', '</compaction-summary>'];
const NARRATIVE_MARKERS = [
  '[User] ',
  '[Assistant] ',
  '[Assistant thinking] ',
  '[Tool call: ',
  '[Tool result',
];
const LONG_LINE_MIN_CHARS = 30;
const REJECT_IDENTICAL_LONG_LINES = 8;
const REJECT_MARKER_LINES = 5;
/**
 * Marker-line share that condemns a summary regardless of absolute count.
 *
 * A raw count misses a DENSE echo. QA agent `ys5hgxyvkpwy` (2026-07-29) used a
 * 2439-char summary for four turns that was pure transcript echo but spread its
 * markers over only 14 lines — 4 markers, one under the count threshold, yet 29%
 * of the document. A genuine summary from the same session ran 65 lines with
 * ZERO markers, so the two separate cleanly on share and not at all on count.
 *
 * `MIN_MARKER_LINES_FOR_DENSITY` keeps a short summary that legitimately quotes
 * one tool call from tripping it.
 */
const REJECT_MARKER_DENSITY = 0.15;
const MIN_MARKER_LINES_FOR_DENSITY = 2;
const ENTROPY_MIN_BYTES = 2000;
const REJECT_GZIP_RATIO = 0.12;

export type SummaryValidation =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'repetition' | 'narrative-echo' | 'low-entropy' };

/**
 * Detects degenerate summarizer output: repetition loops, echoed transcript
 * markup, and low-entropy text. Thresholds sit an order of magnitude from the
 * observed healthy profile (repeats x90 vs x1, 49 marker lines vs 0, gzip
 * ratio 0.084 vs 0.433); a false positive costs a fallback, never a crash.
 */
export function validateCollapseSummary(text: string): SummaryValidation {
  let body = text;
  for (const tag of WRAPPER_TAGS) {
    body = body.replaceAll(tag, '');
  }
  if (body.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const lines = body.split('\n').map((line) => line.trim());

  const longLineCounts = new Map<string, number>();
  let markerLines = 0;
  for (const line of lines) {
    if (NARRATIVE_MARKERS.some((marker) => line.startsWith(marker))) {
      markerLines++;
    }
    if (line.length >= LONG_LINE_MIN_CHARS) {
      const count = (longLineCounts.get(line) ?? 0) + 1;
      longLineCounts.set(line, count);
      if (count >= REJECT_IDENTICAL_LONG_LINES) {
        return { ok: false, reason: 'repetition' };
      }
    }
  }
  if (markerLines >= REJECT_MARKER_LINES) {
    return { ok: false, reason: 'narrative-echo' };
  }
  // Density, for echoes too short to trip the count. See REJECT_MARKER_DENSITY.
  if (
    markerLines >= MIN_MARKER_LINES_FOR_DENSITY &&
    lines.length > 0 &&
    markerLines / lines.length >= REJECT_MARKER_DENSITY
  ) {
    return { ok: false, reason: 'narrative-echo' };
  }

  const bytes = Buffer.byteLength(body);
  if (
    bytes >= ENTROPY_MIN_BYTES &&
    gzipSync(Buffer.from(body)).length / bytes < REJECT_GZIP_RATIO
  ) {
    return { ok: false, reason: 'low-entropy' };
  }
  return { ok: true };
}
