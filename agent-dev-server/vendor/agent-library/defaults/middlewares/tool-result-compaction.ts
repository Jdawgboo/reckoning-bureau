/**
 * Cold-zone tool result compaction.
 *
 * Collects text tool results for async S3 storage, resolves them to
 * `[Stored: ...]` references, and collapses binary tool results to
 * compact `[binary: ...]` labels.
 *
 * Uses message-parts.ts extractors for reading. Direct content access only
 * where index-based mutation is required (resolveCompactions, collapseBinaryToolResults).
 */
import { isToolResultPart, getToolResultString } from '../../kernel/utils/message-parts.ts';
import { buildStoredResultReference } from '../../core/file-first-offloader.ts';
import { formatToolResultForStorage } from '../../core/tool-result-format.ts';
import { estimateToolResultPartTokens } from '../../util/token-estimation.ts';

// ---------------------------------------------------------------------------
// Compaction markers
// ---------------------------------------------------------------------------

/**
 * Prefixes that identify already-compacted tool result outputs.
 * Used by `isStoredReference` to skip re-processing in future compaction cycles.
 */
export const COMPACTION_MARKER_PREFIXES = [
  '[TRUNCATED',
  'Content was removed to save context space (TRUNCATED:',
  '[Stored:',
  'Tool result stored at:',
  '[binary:',
] as const;

// ---------------------------------------------------------------------------
// Internal types for index-based mutation
// ---------------------------------------------------------------------------

interface ToolResultOutputLike {
  type: string;
  value?: unknown;
}

interface MessageLike {
  role: string;
  content: string | unknown[];
}

// ---------------------------------------------------------------------------
// Collection (sync) + Resolution (async)
// ---------------------------------------------------------------------------

export type PendingCompaction = {
  msgIdx: number;
  partIdx: number;
  toolCallId: string;
  toolName: string;
  content: string;
};

/**
 * Collect tool results from a message range for async storage.
 * Returns pending compactions for every tool-result part that has
 * extractable string content and is not already a stored reference.
 */
export function collectToolResultsForStorage<TMsg extends MessageLike>(
  messages: readonly TMsg[],
  startIdx: number,
  endIdx: number,
): PendingCompaction[] {
  const pending: PendingCompaction[] = [];

  for (let msgIdx = startIdx; msgIdx < endIdx; msgIdx++) {
    const msg = messages[msgIdx];
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    if (msg.role !== 'tool') continue;

    for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
      const part = msg.content[partIdx];
      if (!isToolResultPart(part)) continue;
      if (isStoredReference(part.output)) continue;

      const outputStr = getToolResultString(part.output);
      if (outputStr == null || outputStr.length === 0) continue;

      pending.push({
        msgIdx,
        partIdx,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        content: outputStr,
      });
    }
  }

  return pending;
}

/**
 * Resolves pending compactions via async callback.
 * Success: replaces the tool result output with [Stored: {path}] (originals
 * are never mutated — replaced messages are fresh copies).
 * Failure (null): the message is left unchanged and counted in `failedCount`.
 * Callers must then keep the region inline (defer the compaction) — dropping
 * a region whose results were never stored destroys the only copy.
 */
export async function resolveCompactions<TMsg extends MessageLike>(
  messages: TMsg[],
  pendingCompactions: PendingCompaction[],
  compactToolResult: (
    toolCallId: string,
    toolName: string,
    content: string,
  ) => Promise<string | null>,
): Promise<{ messages: TMsg[]; failedCount: number }> {
  if (pendingCompactions.length === 0) {
    return { messages, failedCount: 0 };
  }

  const results = await Promise.all(
    pendingCompactions.map(async (p) => ({
      ...p,
      path: await compactToolResult(p.toolCallId, p.toolName, p.content).catch(() => null),
    })),
  );

  let failedCount = 0;
  const mutated = [...messages];
  for (const r of results) {
    if (!r.path) {
      failedCount += 1;
      continue;
    }
    const msg = mutated[r.msgIdx];
    if (!msg || !Array.isArray(msg.content)) continue;
    const part = msg.content[r.partIdx];
    if (!part || !isToolResultPart(part)) continue;

    const stored: ToolResultOutputLike = { type: 'text', value: `[Stored: ${r.path}]` };
    const content = [...msg.content];
    content[r.partIdx] = { ...part, output: stored };
    mutated[r.msgIdx] = { ...msg, content } as TMsg;
  }

  return { messages: mutated, failedCount };
}

// ---------------------------------------------------------------------------
// Binary collapse
// ---------------------------------------------------------------------------

/**
 * Detect binary tool result output ({type:'content', value:[{type:'image-data'|'file-data',...}]}).
 */
function isBinaryOutput(output: ToolResultOutputLike): boolean {
  if (output.type !== 'content' || !Array.isArray(output.value)) return false;
  return (output.value as unknown[]).some(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      ((item as Record<string, unknown>).type === 'image-data' ||
        (item as Record<string, unknown>).type === 'file-data'),
  );
}

/**
 * Extract the primary mediaType from a binary output's content array.
 * Falls back to 'binary' if none found.
 */
function extractBinaryMediaType(output: ToolResultOutputLike): string {
  if (!Array.isArray(output.value)) return 'binary';
  for (const item of output.value as unknown[]) {
    if (item !== null && typeof item === 'object') {
      const mediaType = (item as Record<string, unknown>).mediaType;
      if (typeof mediaType === 'string') return mediaType;
    }
  }
  return 'binary';
}

/**
 * Collapse binary tool results in a message range to compact text labels.
 *
 * Replaces `{type:'content', value:[{type:'image-data',...}]}` with
 * `{type:'text', value:'[binary: image/jpeg]'}`. This removes inline base64
 * data from the cold zone while preserving the tool result structure.
 *
 * Mutates messages in-place. Skips already-stored references and text results.
 */
export function collapseBinaryToolResults<TMsg extends MessageLike>(messages: TMsg[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content === 'string' || !Array.isArray(msg.content))
      continue;

    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (!isToolResultPart(part)) continue;
      if (isStoredReference(part.output)) continue;
      if (!isBinaryOutput(part.output)) continue;

      const mediaType = extractBinaryMediaType(part.output);
      msg.content[i] = { ...part, output: { type: 'text', value: `[binary: ${mediaType}]` } };
    }
  }
}

// ---------------------------------------------------------------------------
// Stored reference detection
// ---------------------------------------------------------------------------

/** Checks if a tool result output contains a stored reference (already compacted). */
export function isStoredReference(value: unknown): boolean {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const v = (value as { value?: unknown }).value;
    if (typeof v === 'string') {
      return COMPACTION_MARKER_PREFIXES.some((prefix) => v.startsWith(prefix));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Forced-mode truncation (escalation last resort)
// ---------------------------------------------------------------------------

const STORAGE_UNAVAILABLE_HEAD_CHARS = 500;

/**
 * Last-resort replacement for cold-zone tool results whose external storage
 * failed. Only used in forced compaction mode (escalation ≥ 2): losing data
 * beats losing the run. Keeps a short head slice for continuity.
 * Marker starts with '[TRUNCATED' so future cycles skip it (COMPACTION_MARKER_PREFIXES).
 */
export function truncateUnstoredToolResults<TMsg extends MessageLike>(messages: TMsg[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content === 'string' || !Array.isArray(msg.content))
      continue;

    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (!isToolResultPart(part)) continue;
      if (isStoredReference(part.output)) continue;

      const outputStr = getToolResultString(part.output);
      if (outputStr == null || outputStr.length <= STORAGE_UNAVAILABLE_HEAD_CHARS) continue;

      const clipped =
        `[TRUNCATED — storage unavailable] ${part.toolName} output: ` +
        `showing ${STORAGE_UNAVAILABLE_HEAD_CHARS} of ${outputStr.length} chars\n` +
        outputStr.slice(0, STORAGE_UNAVAILABLE_HEAD_CHARS);
      msg.content[i] = { ...part, output: { type: 'text', value: clipped } };
    }
  }
}

/**
 * Walk-side size assumed for a tool-result part that neutralization will
 * replace with a pointer. Upper bound of the pointer + preview estimate
 * (max preview ~6.8k chars at the densest 2.3 chars/token ratio) so the
 * delivered kept window can never exceed the walk's budget.
 */
export const NEUTRALIZED_RESULT_ESTIMATE_TOKENS = 3_300;

const NEUTRALIZATION_PREVIEW = { headLines: 20, tailLines: 10, lineMaxChars: 200 } as const;

/**
 * Lossless neutralization of oversized tool-result parts in the KEPT hot zone:
 * full content is stored externally, a re-readable pointer with preview stays
 * inline. Falls back to clipping when storage is unavailable. The freshest
 * tool message is never touched — the model just requested that result.
 * Non-mutating: returns fresh copies for changed messages.
 */
/**
 * The pointer cache is keyed by (toolCallId, content length, content prefix) —
 * never by toolCallId alone, which recycles under AGE-378 and would serve one
 * result's pointer for a different result. The key stays deterministic per
 * content, preserving the byte-stable re-derivation AGE-379 relies on.
 */
export async function neutralizeOversizedKeptResults<TMsg extends MessageLike>(
  messages: TMsg[],
  maxResultTokens: number,
  model: string | undefined,
  compactToolResult: (
    toolCallId: string,
    toolName: string,
    content: string,
  ) => Promise<string | null>,
  pointerCache: Map<string, string>,
): Promise<{ messages: TMsg[]; neutralizedCount: number }> {
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      lastToolIdx = i;
      break;
    }
  }

  let neutralizedCount = 0;

  const result = await Promise.all(
    messages.map(async (msg, msgIdx) => {
      if (msg.role !== 'tool' || msgIdx === lastToolIdx) return msg;
      if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;

      let changed = false;
      const content = await Promise.all(
        msg.content.map(async (part) => {
          if (!isToolResultPart(part)) return part;
          if (isStoredReference(part.output)) return part;

          const outputStr = getToolResultString(part.output);
          if (outputStr == null) return part;
          // Below the pointer's own size, replacement would grow the prompt.
          const threshold = Math.max(maxResultTokens, NEUTRALIZED_RESULT_ESTIMATE_TOKENS);
          if (estimateToolResultPartTokens(part.output, model) <= threshold) return part;

          changed = true;
          neutralizedCount += 1;

          const cacheKey = `${part.toolCallId}:${outputStr.length}:${outputStr.slice(0, 64)}`;
          const cached = pointerCache.get(cacheKey);
          if (cached != null) {
            return { ...part, output: { type: 'text', value: cached } };
          }

          const path = await compactToolResult(part.toolCallId, part.toolName, outputStr).catch(
            () => null,
          );
          if (path != null) {
            const stored = formatToolResultForStorage(outputStr);
            const pointer = buildStoredResultReference(path, stored, NEUTRALIZATION_PREVIEW);
            pointerCache.set(cacheKey, pointer);
            return { ...part, output: { type: 'text', value: pointer } };
          }

          const maxChars = maxResultTokens * 3;
          const clipped =
            `[TRUNCATED — oversized result: showing ${maxChars} of ${outputStr.length} chars]\n` +
            outputStr.slice(0, maxChars);
          return { ...part, output: { type: 'text', value: clipped } };
        }),
      );

      if (!changed) return msg;
      return { ...msg, content } as TMsg;
    }),
  );

  return { messages: result, neutralizedCount };
}

/**
 * Hard-clip oversized tool results in the KEPT hot zone so a single huge
 * turn cannot exceed the context budget by itself. Forced mode only.
 * Non-mutating: returns fresh copies for changed messages.
 */
export function clipOversizedToolResults<TMsg extends MessageLike>(
  messages: TMsg[],
  maxChars: number,
): TMsg[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      return msg;
    }

    let changed = false;
    const content = msg.content.map((part) => {
      if (!isToolResultPart(part)) return part;
      if (isStoredReference(part.output)) return part;

      const outputStr = getToolResultString(part.output);
      if (outputStr == null || outputStr.length <= maxChars) return part;

      changed = true;
      const clipped =
        `[TRUNCATED — forced compaction: showing ${maxChars} of ${outputStr.length} chars]\n` +
        outputStr.slice(0, maxChars);
      return { ...part, output: { type: 'text', value: clipped } };
    });

    if (!changed) return msg;
    return { ...msg, content } as TMsg;
  });
}
