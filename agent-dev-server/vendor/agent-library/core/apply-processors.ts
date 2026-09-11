import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { TurnProcessor, TurnProcessorState } from '../kernel/processors/types.ts';

/**
 * Applies turn-level processors in order and returns the messages to SEND.
 *
 * A processor that adds facts (system prompt, the turn's user message) writes its result back to
 * state, so the log grows and later processors see it. A processor marked `projection` does not:
 * its output shapes the prompt and the log is left byte-identical.
 *
 * That distinction is the append-only rule from `design.md:20` made structural. Repair rewrites
 * messages that already exist; committing such a rewrite is indistinguishable, to the writer's
 * diff, from injecting new content — which is how repaired copies came to be persisted next to
 * the originals they replaced (PROD 2026-07-30).
 */
export async function applyProcessors(params: {
  state: TurnProcessorState;
  processors: TurnProcessor[];
}): Promise<ModelMessage[]> {
  const { state, processors } = params;
  let projected: ModelMessage[] | null = null;

  for (const processor of processors) {
    const next = await processor.process(state);
    if (!next) continue;
    if (processor.projection === true) {
      projected = next;
      continue;
    }
    // A log-writing processor invalidates any earlier projection: it changed the facts the
    // projection was derived from, so that projection no longer describes this history.
    projected = null;
    state.setConversationHistory(next);
  }

  return projected ?? state.getConversationHistory();
}
