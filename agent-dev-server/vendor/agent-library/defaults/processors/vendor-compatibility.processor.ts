import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { TurnProcessor, TurnProcessorState } from '../../kernel/processors/types.ts';

/**
 * Filters out content part types that specific LLM vendors don't support.
 *
 * Accepts the excluded types list via constructor so the processor has no
 * dependency on the model registry. The caller resolves vendor → excluded
 * types at agent creation time.
 *
 * Excluded types name *content parts* (e.g. `reasoning`), not messages — a
 * `ModelMessage` carries only `role` and `content`. A message is dropped
 * entirely only when stripping leaves its content empty.
 */
export class VendorCompatibilityProcessor implements TurnProcessor {
  #excludedTypes: ReadonlySet<string>;

  constructor(excludedTypes: string[]) {
    this.#excludedTypes = new Set(excludedTypes);
  }

  async process(state: TurnProcessorState): Promise<ModelMessage[] | null> {
    if (this.#excludedTypes.size === 0) return null;

    const history = state.getConversationHistory();
    const filtered: ModelMessage[] = [];
    let changed = false;

    for (const message of history) {
      const stripped = this.#stripExcludedParts(message);
      if (stripped === message) {
        filtered.push(message);
        continue;
      }
      changed = true;
      if (stripped !== null) {
        filtered.push(stripped);
      }
    }

    return changed ? filtered : null;
  }

  /**
   * Returns the message unchanged when nothing is stripped, a rewritten copy
   * when parts are removed, or null when no content survives.
   *
   * Only assistant messages are considered: reasoning and other vendor-specific
   * parts exist solely in `AssistantContent`.
   */
  #stripExcludedParts(message: ModelMessage): ModelMessage | null {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return message;
    }

    const kept = message.content.filter((part) => !this.#excludedTypes.has(part.type));
    if (kept.length === message.content.length) {
      return message;
    }
    if (kept.length === 0) {
      return null;
    }

    return { ...message, content: kept };
  }
}
