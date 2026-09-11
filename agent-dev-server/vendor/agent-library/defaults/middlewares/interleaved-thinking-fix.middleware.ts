import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import type { KernelModelMiddleware } from '../../kernel/middlewares/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

/**
 * Workaround for a Bedrock Converse API bug where interleaved thinking + tool_use
 * in a single assistant message is rejected even though the tool_result exists
 * in the immediately-next message.
 *
 * The pattern the model produces with `interleaved-thinking-2025-05-14`:
 *   assistant: [reasoning, text, toolUse(A), reasoning, text, toolUse(B)]
 *   tool: [toolResult(A), toolResult(B)]
 *
 * Bedrock rejects this with:
 *   "tool_use ids found without tool_result blocks immediately after"
 *
 * Fix: split the assistant message so each tool-call group is self-contained:
 *   assistant: [reasoning, text, toolUse(A)]
 *   tool: [toolResult(A)]
 *   assistant: [reasoning, text, toolUse(B)]
 *   tool: [toolResult(B)]
 *
 * Runs as transformParams (before every model call) so it catches interleaved
 * messages both from committed history AND from the current turn's tool loop.
 */
export class InterleavedThinkingFixMiddleware implements KernelModelMiddleware {
  create(): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        const opts = params as LanguageModelV3CallOptions;
        const fixed = splitInterleavedPrompt(opts.prompt);
        if (!fixed) return opts;
        return { ...opts, prompt: fixed };
      },
    };
  }
}

export function splitInterleavedPrompt(
  prompt: LanguageModelV3Message[],
): LanguageModelV3Message[] | null {
  // Quick scan: any assistant message with tool-call NOT at the end?
  let needsSplit = false;
  for (const msg of prompt) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const parts = msg.content as Part[];
    for (let k = 0; k < parts.length - 1; k++) {
      if (parts[k].type === 'tool-call' && parts[k + 1]?.type !== 'tool-call') {
        needsSplit = true;
        break;
      }
    }
    if (needsSplit) break;
  }

  if (!needsSplit) return null;

  // Build FIFO result queues from tool messages. Queued per id — never a
  // last-wins map — because provider-recycled ids (AGE-378) repeat across
  // responses: each call occurrence consumes its own result in order.
  const resultQueues = new Map<string, Part[]>();
  for (const msg of prompt) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as Part[]) {
      if (part.type === 'tool-result' && part.toolCallId) {
        const queue = resultQueues.get(part.toolCallId) ?? [];
        queue.push(part);
        resultQueues.set(part.toolCallId, queue);
      }
    }
  }

  const emitted = new Set<Part>();
  const result: LanguageModelV3Message[] = [];

  for (const msg of prompt) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        // Filter out result PARTS already emitted inline (by reference — ids
        // recycle, so an id-keyed filter would drop later legitimate results)
        const remaining = (msg.content as Part[]).filter((p) => !emitted.has(p));
        if (remaining.length > 0) {
          result.push({ ...msg, content: remaining } as LanguageModelV3Message);
        }
      } else {
        result.push(msg);
      }
      continue;
    }

    const parts = msg.content as Part[];

    // Check if this message needs splitting
    let hasInterleaved = false;
    for (let k = 0; k < parts.length - 1; k++) {
      if (parts[k].type === 'tool-call' && parts[k + 1]?.type !== 'tool-call') {
        hasInterleaved = true;
        break;
      }
    }

    if (!hasInterleaved) {
      result.push(msg);
      continue;
    }

    // Split into groups ending at each tool-call boundary
    let group: Part[] = [];
    for (let k = 0; k < parts.length; k++) {
      group.push(parts[k]);

      const isToolCall = parts[k].type === 'tool-call';
      const nextIsToolCall = k + 1 < parts.length && parts[k + 1]?.type === 'tool-call';

      if (isToolCall && !nextIsToolCall) {
        result.push({ ...msg, content: [...group] } as LanguageModelV3Message);

        // Emit matching tool results
        const callIds = group
          .filter((p) => p.type === 'tool-call' && p.toolCallId)
          .map((p) => p.toolCallId!);

        const matchingResults = callIds
          .map((id) => resultQueues.get(id)?.shift())
          .filter((r): r is Part => r != null);

        if (matchingResults.length > 0) {
          result.push({
            role: 'tool',
            content: matchingResults,
          } as LanguageModelV3Message);
          for (const part of matchingResults) emitted.add(part);
        }

        group = [];
      }
    }

    // Any remaining non-tool-call content
    if (group.length > 0) {
      result.push({ ...msg, content: [...group] } as LanguageModelV3Message);
    }
  }

  return result;
}
