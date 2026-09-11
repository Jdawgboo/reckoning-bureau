/**
 * Line-based content cap for file read results.
 *
 * When a file exceeds the line cap and no explicit view range was requested,
 * returns the first N lines with a footer noting the total. The model can
 * then use viewRanges for targeted reads of specific sections.
 *
 * This replaces file-first offloading for read results — the model asked
 * for this content, so it should receive actual code, not a storage reference.
 */

export const DEFAULT_FILE_LINE_CAP = 600;

export type CappedFileResult = {
  content: string;
  capped: boolean;
  totalLines: number;
  returnedLines: number;
};

/**
 * Cap file content to a maximum number of lines.
 *
 * If content exceeds `lineCap`, returns the first `lineCap` lines with a
 * footer indicating how many lines were omitted and the total line count.
 * If content fits within the cap, returns it unchanged.
 */
export function capFileContent(content: string, lineCap = DEFAULT_FILE_LINE_CAP): CappedFileResult {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= lineCap) {
    return { content, capped: false, totalLines, returnedLines: totalLines };
  }

  const capped =
    lines.slice(0, lineCap).join('\n') +
    '\n\n... [Read more with viewRanges: [{"startLine": N, "endLine": M}].]';

  return { content: capped, capped: true, totalLines, returnedLines: lineCap };
}
