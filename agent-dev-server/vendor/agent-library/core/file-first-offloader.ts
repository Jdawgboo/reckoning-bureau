import type { ToolOutput } from '../types/tool-output.ts';
import { formatToolResultForStorage } from './tool-result-format.ts';

export interface FileFirstConfig {
  /** Offload results exceeding this char count. Default: 2000 */
  offloadThreshold: number;
  /** Head lines to include in preview. Default: 5 */
  previewHeadLines: number;
  /** Tail lines to include in preview. Default: 5 */
  previewTailLines: number;
  /** Max chars per preview line. Default: 1000 */
  previewLineMaxChars: number;
  /** Write callback — returns true on success, false to fall back to inline. */
  write: (path: string, content: string) => Promise<boolean>;
}

export const DEFAULT_FILE_FIRST_CONFIG: FileFirstConfig = {
  offloadThreshold: 2000,
  previewHeadLines: 5,
  previewTailLines: 5,
  previewLineMaxChars: 1000,
  write: async () => false,
};

export interface OffloadResult {
  /** The compact reference string to return to the LLM instead of the full output. */
  compactReference: string;
  /** The file path where the full output was stored. */
  filePath: string;
}

/**
 * Generate a head+tail preview of text content.
 */
export function generatePreview(
  text: string,
  headLines: number,
  tailLines: number,
  maxCharsPerLine: number,
): string {
  const lines = text.split('\n');
  const totalLines = lines.length;

  const truncLine = (line: string, lineNum: number): string => {
    const trimmed = line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine)}...` : line;
    return `  ${lineNum}  ${trimmed}`;
  };

  if (totalLines <= headLines + tailLines) {
    return lines.map((line, i) => truncLine(line, i + 1)).join('\n');
  }

  const head = lines.slice(0, headLines).map((line, i) => truncLine(line, i + 1));
  const tail = lines
    .slice(-tailLines)
    .map((line, i) => truncLine(line, totalLines - tailLines + i + 1));
  const omitted = totalLines - headLines - tailLines;

  return [...head, `  ... [${omitted} lines truncated] ...`, ...tail].join('\n');
}

/**
 * Estimate token count from character length (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(charCount: number): number {
  return Math.round(charCount / 4);
}

/**
 * Build the re-readable pointer that replaces a stored tool result: path,
 * head/tail preview of the stored (formatted) content, and re-read hint.
 * The leading "Tool result stored at:" is a compaction marker — keep it stable.
 */
export function buildStoredResultReference(
  filePath: string,
  storedContent: string,
  preview: { headLines: number; tailLines: number; lineMaxChars: number },
): string {
  const previewText = generatePreview(
    storedContent,
    preview.headLines,
    preview.tailLines,
    preview.lineMaxChars,
  );
  const tokens = estimateTokens(storedContent.length);

  return (
    `Tool result stored at: ${filePath} (estimated ~${tokens.toLocaleString()} tokens)\n\n` +
    `Preview:\n${previewText}\n\n` +
    `Full content available at: ${filePath}`
  );
}

/**
 * Attempt to offload a tool result to file storage.
 *
 * Returns null if the result should stay inline (below threshold, tool
 * declares skipOffload, non-string output, or write failure).
 *
 * Single-line JSON results are pretty-printed before storage so Grep,
 * viewRanges, and previews work per line; large non-JSON outputs should be
 * formatted as multi-line text by the tool itself.
 *
 * @param skipOffload - When true, skip offloading regardless of size.
 *   Sourced from `ToolModel.skipOffload` at the call site.
 */
export async function offloadToolResult(
  output: ToolOutput,
  toolCallId: string,
  config: FileFirstConfig,
  skipOffload: boolean,
): Promise<OffloadResult | null> {
  if (typeof output !== 'string') return null;
  if (skipOffload) return null;
  if (output.length <= config.offloadThreshold) return null;

  // Preview and token estimate below describe the stored (formatted) content.
  const storedContent = formatToolResultForStorage(output);

  const filePath = `tool-results/${toolCallId}.txt`;
  let writeSuccess: boolean;
  try {
    writeSuccess = await config.write(filePath, storedContent);
  } catch {
    writeSuccess = false;
  }
  if (!writeSuccess) return null;

  const compactReference = buildStoredResultReference(filePath, storedContent, {
    headLines: config.previewHeadLines,
    tailLines: config.previewTailLines,
    lineMaxChars: config.previewLineMaxChars,
  });

  return { compactReference, filePath };
}
