import type { ModelMessage } from '@ai-sdk/provider-utils';
import { isToolCallPart, isToolResultPart } from './message-parts.ts';

/**
 * One assistant tool-call part with its order-sensitive resolution status.
 *
 * Providers such as OpenAI-compatible models served through Bedrock Mantle
 * mint per-response sequential tool-call ids (`call_1`, `call_2`, …) that
 * repeat across responses (AGE-378), so a toolCallId alone never identifies a
 * call. Pairing is FIFO per id in encounter order: each tool-result resolves
 * the oldest still-unresolved call carrying its id.
 */
export interface ToolCallOccurrence {
  /** The tool-call part object as it appears in the message content array. */
  part: unknown;
  /** Identity of the call itself: toolCallId + toolName + JSON(input). */
  key: string;
  toolCallId: string;
  toolName: string;
  messageIndex: number;
  resolved: boolean;
  /** The tool-result part that resolved this occurrence (FIFO), if any. */
  resultPart: unknown | null;
}

/**
 * Pairs assistant tool-calls with tool-results in encounter order (FIFO per
 * toolCallId) and returns every call occurrence with its resolution status.
 */
export function pairToolCallOccurrences(history: readonly ModelMessage[]): ToolCallOccurrence[] {
  const occurrences: ToolCallOccurrence[] = [];
  const unresolvedById = new Map<string, ToolCallOccurrence[]>();

  for (const [messageIndex, msg] of history.entries()) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (!isToolCallPart(part)) continue;
        const key = `${part.toolCallId} ${part.toolName} ${JSON.stringify(part.input)}`;
        const occurrence: ToolCallOccurrence = {
          part,
          key,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          messageIndex,
          resolved: false,
          resultPart: null,
        };
        occurrences.push(occurrence);
        const queue = unresolvedById.get(part.toolCallId) ?? [];
        queue.push(occurrence);
        unresolvedById.set(part.toolCallId, queue);
      }
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (!isToolResultPart(part)) continue;
        const oldest = unresolvedById.get(part.toolCallId)?.shift();
        if (oldest) {
          oldest.resolved = true;
          oldest.resultPart = part;
        }
      }
    }
  }

  return occurrences;
}

/**
 * Tool-call parts carrying the re-persisted-copy signature (AGE-351 corruption
 * under AGE-378 id recycling): unresolved by FIFO pairing, byte-identical to
 * an earlier occurrence that WAS resolved, and not in the final message of
 * history (a truly in-flight call is always at the absolute tail).
 *
 * Shared by `HistoryDoctorProcessor` (which drops these parts) and the
 * builder-lab validators (which flag them), so the lab verdict and the runtime
 * repair can never drift.
 */
export function findCopyToolCallParts(history: readonly ModelMessage[]): Set<unknown> {
  const occurrences = pairToolCallOccurrences(history);
  const copies = new Set<unknown>();
  const resolvedKeysSoFar = new Set<string>();
  const tailIndex = history.length - 1;

  for (const occurrence of occurrences) {
    if (
      !occurrence.resolved &&
      resolvedKeysSoFar.has(occurrence.key) &&
      occurrence.messageIndex !== tailIndex
    ) {
      copies.add(occurrence.part);
    }
    if (occurrence.resolved) {
      resolvedKeysSoFar.add(occurrence.key);
    }
  }
  return copies;
}

/**
 * Tool-result parts that resolve no call under FIFO pairing — either excess
 * duplicates of an already-consumed result or results whose call never
 * existed. Legitimate id recycling (each result following its own call) is
 * never flagged.
 */
export function findUnpairedToolResultParts(history: readonly ModelMessage[]): Set<unknown> {
  const unresolvedById = new Map<string, number>();
  const unpaired = new Set<unknown>();

  for (const msg of history) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (!isToolCallPart(part)) continue;
        unresolvedById.set(part.toolCallId, (unresolvedById.get(part.toolCallId) ?? 0) + 1);
      }
    } else if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (!isToolResultPart(part)) continue;
        const open = unresolvedById.get(part.toolCallId) ?? 0;
        if (open > 0) {
          unresolvedById.set(part.toolCallId, open - 1);
        } else {
          unpaired.add(part);
        }
      }
    }
  }
  return unpaired;
}
