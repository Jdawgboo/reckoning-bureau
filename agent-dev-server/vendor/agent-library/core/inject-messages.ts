import type { ModelMessage } from '@ai-sdk/provider-utils';

/**
 * The single implementation of "interleave injected messages into a response".
 *
 * There used to be two: one in the builder's `prepareStep` (building the prompt)
 * and one in `AgentState.commitPendingStepInjections` (writing history), each
 * with its own copy of `findSafeInjectionPosition`. Only the prompt copy carried
 * the AGE-367 clamp.
 *
 * That asymmetry sat on the retry path. `agent.service.ts` commits pending
 * injections and step messages AFTER its try/catch, so a failed attempt's output
 * and reminders are committed before the retry runs — meaning the retry's prompt
 * is built from the COMMITTED interleaving while the failed attempt's prompt used
 * the PROMPT interleaving. Any disagreement between the two rewrites the prefix
 * the provider cached, at 12.5x the cached rate, on exactly the path already
 * paying for a retry.
 *
 * They agree today (`scripts/builder-lab/tests/injection-interleave-parity.test.ts`
 * pins it across 300 sequences), but agreement between two copies is a property
 * that has to be maintained. One copy cannot disagree with itself.
 */

/**
 * Adjusts an injection position so a user message is never inserted between an
 * assistant tool-call and its tool result — the shape that produces
 * `MissingToolResultsError` in `convertToLanguageModelPrompt`.
 */
export function findSafeInjectionPosition(messages: ModelMessage[], position: number): number {
  if (position <= 0) return position;
  const clamped = Math.min(position, messages.length);

  let blockStart = clamped;
  while (blockStart > 0 && role(messages[blockStart - 1]) === 'tool') {
    blockStart--;
  }

  const anchor = messages[blockStart - 1];
  if (!anchor || !hasClientToolCall(anchor)) {
    return clamped;
  }

  let afterResults = blockStart;
  while (afterResults < messages.length && role(messages[afterResults]) === 'tool') {
    afterResults++;
  }

  if (afterResults === blockStart) {
    return blockStart - 1;
  }

  return Math.max(clamped, afterResults);
}

function role(message: ModelMessage | undefined): string | undefined {
  return (message as { role?: string } | undefined)?.role;
}

function hasClientToolCall(message: ModelMessage): boolean {
  const content = (message as { role?: string; content?: unknown }).content;
  if ((message as { role?: string }).role !== 'assistant' || !Array.isArray(content)) return false;
  return (content as Array<{ type?: string; providerExecuted?: boolean }>).some(
    (part) => part.type === 'tool-call' && !part.providerExecuted,
  );
}

/**
 * Interleaves `injections` into `response`, each at its recorded position,
 * returning a new array. The output is always `response` in order plus every
 * injection message exactly once (`length === response.length + injections.length`).
 *
 * Positions are clamped to `[cursor, response.length]` before slicing, where
 * `cursor` is the high-water mark of already-emitted response indices. Without
 * the clamp, a position pointing earlier than an already-consumed index makes
 * the trailing `response.slice(cursor)` re-emit a segment that was already
 * emitted — duplicating whole tool-call/tool-result pairs (AGE-367, seen when a
 * stream restart hands stale positions recorded against a longer,
 * pre-compaction response). Clamping degrades a stale position to "insert here"
 * instead of duplicating, so duplication is unreachable regardless of how the
 * positions were produced.
 */
export function insertInjections(
  response: ModelMessage[],
  injections: { position: number; message: ModelMessage }[],
): ModelMessage[] {
  const enhanced: ModelMessage[] = [];
  let cursor = 0;
  for (const { position, message } of injections) {
    const safePosition = findSafeInjectionPosition(response, position);
    const clamped = Math.min(Math.max(safePosition, cursor), response.length);
    enhanced.push(...response.slice(cursor, clamped));
    enhanced.push(message);
    cursor = clamped;
  }
  if (cursor < response.length) {
    enhanced.push(...response.slice(cursor));
  }
  return enhanced;
}
