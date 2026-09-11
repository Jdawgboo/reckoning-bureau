import type { SearchOptions, SearchResult, SearchFileResult } from './types.ts';

const DEFAULT_TRUNCATE_WINDOW = 400;
const TRUNCATED_SUFFIX = ' [line truncated]';

/** Budgets for in-process search over remote adapters (list + read + textSearch). */
export const SEARCH_MAX_FILES = 200;
export const SEARCH_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Bound a matched line to a window around the first match so a single long
 * line (e.g. a serialized tool output) can never dump kilobytes into results.
 * Keep most of the budget after the match because serialized diagnostics put
 * stack frames and causal context there.
 */
export function truncateMatchContent(
  content: string,
  pattern: string,
  opts?: { window?: number },
): string {
  const window = opts?.window ?? DEFAULT_TRUNCATE_WINDOW;
  if (content.length <= window) {
    return content;
  }
  let matchIndex = 0;
  try {
    const index = content.search(new RegExp(pattern));
    if (index >= 0) {
      matchIndex = index;
    }
  } catch {
    // invalid regex for search(): keep the head window
  }
  const contextBeforeMatch = Math.floor(window / 4);
  const start = Math.max(0, matchIndex - contextBeforeMatch);
  const end = Math.min(content.length, start + window);
  const head = start > 0 ? '…' : '';
  return `${head}${content.slice(start, end)}…${TRUNCATED_SUFFIX}`;
}

/**
 * In-process regex search over a map of file contents.
 * Shared by InMemoryAdapter, ToolResultsAdapter, and other adapters
 * that hold content in memory.
 */
export function textSearch(
  files: ReadonlyMap<string, string>,
  pattern: string,
  options?: SearchOptions,
): SearchResult[] | SearchFileResult[] {
  const regex = new RegExp(pattern, options?.ignoreCase ? 'gi' : 'g');
  const contextLines = options?.context ?? 0;
  const results: SearchResult[] = [];
  const fileResults: SearchFileResult[] = [];

  for (const [filePath, content] of files) {
    if (options?.path && !filePath.startsWith(options.path)) continue;

    const lines = content.split('\n');
    let fileMatched = false;

    for (let i = 0; i < lines.length; i++) {
      // Reset regex state for each line (important for 'g' flag)
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;

      if (options?.filesOnly) {
        if (!fileMatched) {
          fileResults.push({ file: filePath });
          fileMatched = true;
        }
        continue;
      }

      const boundLine = (line: string) => truncateMatchContent(line, pattern);
      const before =
        contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i).map(boundLine) : undefined;
      const after =
        contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines).map(boundLine) : undefined;

      results.push({
        file: filePath,
        line: i + 1,
        content: truncateMatchContent(lines[i], pattern),
        ...(before || after ? { context: { before: before ?? [], after: after ?? [] } } : {}),
      });

      if (options?.maxResults && results.length >= options.maxResults) {
        return results;
      }
    }
  }

  return options?.filesOnly ? fileResults : results;
}
