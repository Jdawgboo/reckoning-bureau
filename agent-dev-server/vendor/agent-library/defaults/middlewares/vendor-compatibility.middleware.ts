import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { KernelModelMiddleware } from '../../kernel/middlewares/types.ts';

/**
 * Strips the content-part types the caller lists, on every request.
 *
 * Applies the given list; it does not decide what belongs on it. Callers resolve
 * that policy — see `resolveExcludedMessageTypes` in the server.
 *
 * `VendorCompatibilityProcessor` does the same job once per ATTEMPT, on the
 * history loaded at attempt start. Reasoning, though, is produced per STEP: in a
 * multi-step tool loop the model's own output is appended and reaches the next
 * step's prompt without passing through a processor again, so step 2 onwards
 * would otherwise carry parts the attempt-level filter never saw — tracked as
 * I2, and reproduced in
 * `scripts/builder-lab/tests/vendor-filter-in-stream.test.ts`.
 *
 * Cadence is the whole point: middlewares run per request, so this sees exactly
 * what the provider will. It shapes the outgoing prompt only and never rewrites
 * history — the processor's job of keeping stored history vendor-clean across
 * turns is unchanged.
 */
export class VendorCompatibilityMiddleware implements KernelModelMiddleware {
  readonly #excludedTypes: ReadonlySet<string>;

  constructor(excludedTypes: readonly string[]) {
    this.#excludedTypes = new Set(excludedTypes);
  }

  create(): LanguageModelMiddleware {
    const excluded = this.#excludedTypes;
    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }: { params: LanguageModelV3CallOptions }) => {
        if (excluded.size === 0) return params;

        const messages = params.prompt as LanguageModelV3Message[];
        const filtered: LanguageModelV3Message[] = [];
        let changed = false;

        for (const message of messages) {
          const stripped = stripExcludedParts(message, excluded);
          if (stripped === message) {
            filtered.push(message);
            continue;
          }
          changed = true;
          if (stripped !== null) filtered.push(stripped);
        }

        return changed ? { ...params, prompt: filtered } : params;
      },
    };
  }
}

/**
 * The message unchanged when nothing is stripped, a rewritten copy when parts
 * are removed, or null when no content survives.
 *
 * Assistant messages only: reasoning and other vendor-specific parts are
 * produced by the model, and dropping parts from a user or tool message would
 * change what the conversation says rather than how it is encoded.
 */
function stripExcludedParts(
  message: LanguageModelV3Message,
  excluded: ReadonlySet<string>,
): LanguageModelV3Message | null {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) {
    return message;
  }

  const kept = message.content.filter((part) => !excluded.has(part.type));
  if (kept.length === message.content.length) return message;
  if (kept.length === 0) return null;

  return { ...message, content: kept } as LanguageModelV3Message;
}
