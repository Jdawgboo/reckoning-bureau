import type { AgentStorage } from '../../storage/agent-storage.ts';
import { validateCollapseSummary } from './summary-validation.ts';

const HISTORY_FILE_RE = /^compaction-history-(\d{1,4})\.md$/;
const HISTORY_POINTER_PREFIX = 'Full pre-compaction history of this session is stored in ';

export type CompactionHistoryStorage = Pick<AgentStorage, 'listFiles' | 'exists' | 'resolvePath'>;

export type SummaryGenerationResult = { text: string; ok: boolean };

/**
 * Next free numbered history file in `dir` (a routed path, e.g.
 * 'tool-results/<sessionId>' or 'tool-results/compaction/main'): one LIST →
 * max index + 1, with an exists() cross-check. Any uncertainty degrades to a
 * unique timestamp name, never to reusing an index. The index regex accepts
 * 1-4 digits so timestamp-named fallback files never bump the max.
 * Contract: one writer per directory.
 */
export async function nextCompactionHistoryPath(
  storage: CompactionHistoryStorage,
  dir: string,
): Promise<string> {
  const routedDir = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const fallback = `${routedDir}/compaction-history-${Date.now()}.md`;
  try {
    const { adapter, relativePath } = storage.resolvePath(`${routedDir}/`);
    const files = await storage.listFiles([adapter]);
    const prefix = relativePath ? `${relativePath}/` : '';
    let maxIndex = 0;
    for (const file of files) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }
      const name = file.path.slice(prefix.length);
      if (name.includes('/')) {
        continue;
      }
      const match = name.match(HISTORY_FILE_RE);
      if (match) {
        maxIndex = Math.max(maxIndex, Number(match[1]));
      }
    }
    const candidate = `${routedDir}/compaction-history-${maxIndex + 1}.md`;
    if (await storage.exists(candidate)) {
      return fallback;
    }
    return candidate;
  } catch {
    return fallback;
  }
}

/**
 * Deterministic pointer block appended in code (never delegated to the
 * summarizer model) inside the compaction-summary wrapper. Wording must stay
 * in sync with stripCompactionHistoryPointers.
 */
export function buildCompactionHistoryPointer(dir: string, latestPath: string): string {
  const normalized = dir.endsWith('/') ? dir : `${dir}/`;
  return (
    `${HISTORY_POINTER_PREFIX}"${normalized}" ` +
    `(compaction-history-*.md, one file per compaction; latest: "${latestPath}"). ` +
    `List or read it if you need exact details from before this summary.`
  );
}

/** Drops pointer lines appended by buildCompactionHistoryPointer so they do not compound. */
export function stripCompactionHistoryPointers(summary: string): string {
  return summary
    .split('\n')
    .filter((line) => !line.startsWith(HISTORY_POINTER_PREFIX))
    .join('\n')
    .trim();
}

/**
 * Shared summarizer policy: run the primary, validate its output; on
 * rejection OR a thrown call (AGE-383: a 429/outage on the primary must not
 * skip the backup) run the cross-model fallback once (temperature-0
 * same-model retries return the same output) and validate again. A thrown
 * fallback propagates so the caller can rethrow to CompactionMiddleware's
 * chain-preserving/defer handling. ok=false returns the last attempt's text
 * unmodified.
 */
export async function generateSummaryWithFallback(
  primary: () => Promise<string>,
  fallback: (() => Promise<string>) | null,
  onRejected: (reason: string, stage: 'primary' | 'fallback') => void,
): Promise<SummaryGenerationResult> {
  let text: string;
  try {
    text = await primary();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onRejected(`call failed: ${message}`, 'primary');
    if (!fallback) {
      throw error;
    }
    const fallbackText = await fallback();
    const verdict = validateCollapseSummary(fallbackText);
    if (verdict.ok === false) {
      onRejected(verdict.reason, 'fallback');
      return { text: fallbackText, ok: false };
    }
    return { text: fallbackText, ok: true };
  }
  const primaryVerdict = validateCollapseSummary(text);
  if (primaryVerdict.ok !== false) {
    return { text, ok: true };
  }
  onRejected(primaryVerdict.reason, 'primary');
  if (!fallback) {
    return { text, ok: false };
  }
  text = await fallback();
  const fallbackVerdict = validateCollapseSummary(text);
  if (fallbackVerdict.ok !== false) {
    return { text, ok: true };
  }
  onRejected(fallbackVerdict.reason, 'fallback');
  return { text, ok: false };
}

/**
 * Remove a code fence and an outer `<compaction-summary>` tag the model wrapped
 * around its own output, before the caller adds the real one.
 *
 * The summary prompt asks for markdown and never mentions XML. But on the update
 * path the model is shown the PREVIOUS summary already wrapped in
 * `<compaction-summary>` tags, so it imitates the wrapper it can see and reaches
 * for a fence to hold it. Instructions say markdown; the example in context says
 * XML; the example wins.
 *
 * Both summarizers then wrap again — `builder-compaction-summarizer.ts` and
 * `agent-compaction-summarizer.ts` both do
 * `<compaction-summary>\n${text}\n</compaction-summary>` — producing a fenced
 * block containing a duplicate tag. Observed in a real run: one summary grew
 * from 1383 to 1871 chars, most of it wrapper.
 *
 * It compounds, which is the reason to fix it rather than tolerate it: the
 * update path feeds each summary back as the example for the next.
 */
export function stripModelSummaryWrapper(text: string): string {
  let cleaned = text.trim();

  const fence = cleaned.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) {
    cleaned = fence[1].trim();
  }

  const tagged = cleaned.match(/^<compaction-summary>\s*([\s\S]*?)\s*<\/compaction-summary>$/);
  if (tagged) {
    cleaned = tagged[1].trim();
  }

  return cleaned;
}

/**
 * A previous summary is only usable as an example if it is itself valid.
 *
 * The update path shows the model the last summary and asks it to extend it. If
 * that summary is a transcript echo, the model imitates it — reproduced against
 * the live model, where a poisoned previous summary induced another echo even
 * with a prompt that explicitly forbids continuing the transcript. The example
 * in context beats the instruction.
 *
 * So the loop is broken on the way IN, not only on the way out: an invalid
 * previous summary is dropped, and the caller falls back to the initial prompt,
 * which states the full template and produces a clean summary. One bad summary
 * then costs one lost increment instead of poisoning every turn after it.
 *
 * Returns null when there is nothing safe to carry forward.
 */
export function usablePreviousSummary(previousSummary: string | null): string | null {
  if (!previousSummary) return null;
  const stripped = stripCompactionHistoryPointers(previousSummary);
  if (!stripped) return null;
  return validateCollapseSummary(stripped).ok ? stripped : null;
}
