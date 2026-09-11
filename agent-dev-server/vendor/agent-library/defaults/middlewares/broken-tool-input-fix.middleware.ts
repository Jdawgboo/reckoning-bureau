import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import type { KernelModelMiddleware } from '../../kernel/middlewares/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the repair reshapes parts the provider types treat as already-valid
type Part = any;

/**
 * Fixes tool-call parts with broken (non-object) input before they reach Bedrock.
 *
 * When the model's response is truncated mid-generation (finishReason: 'length'),
 * the AI SDK stores the incomplete JSON string as the tool-call input. On the next
 * step, this string input is sent to Bedrock which requires a JSON object.
 *
 * Error: "The format of the value at messages.N.content.M.toolUse.input is invalid.
 *         Provide a json object for the field and try again."
 *
 * Fix: replace string inputs with `{ _error: "truncated" }` so Bedrock accepts them.
 * The tool result is typically already a synthetic "cancelled" message from the Doctor.
 *
 * Runs as transformParams (before every model call) to catch broken inputs both
 * from committed history AND from the current turn's tool loop.
 */
export class BrokenToolInputFixMiddleware implements KernelModelMiddleware {
  create(): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        const opts = params as LanguageModelV3CallOptions;
        const fixed = fixBrokenInputs(opts.prompt);
        if (!fixed) return opts;
        return { ...opts, prompt: fixed };
      },
    };
  }
}

function fixBrokenInputs(prompt: LanguageModelV3Message[]): LanguageModelV3Message[] | null {
  let needsFix = false;

  for (const msg of prompt) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as Part[]) {
      if (part.type === 'tool-call' && typeof part.input !== 'object') {
        needsFix = true;
        break;
      }
    }
    if (needsFix) break;
  }

  if (!needsFix) return null;

  return prompt.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;

    let changed = false;
    const content = (msg.content as Part[]).map((part: Part) => {
      if (part.type === 'tool-call' && typeof part.input !== 'object') {
        changed = true;
        return {
          ...part,
          input: { _error: 'truncated', _original: String(part.input).slice(0, 200) },
        };
      }
      return part;
    });

    return changed ? ({ ...msg, content } as LanguageModelV3Message) : msg;
  });
}
