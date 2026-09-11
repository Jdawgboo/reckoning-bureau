import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { KernelModelMiddleware } from '../../kernel/middlewares/types.ts';

/**
 * Workaround for a bug in @ai-sdk/amazon-bedrock where reasoning blocks
 * with only a signature (no text delta) emit `reasoning-delta` without a
 * preceding `reasoning-start`. This causes stream-text.ts in the ai package
 * to throw "reasoning part N not found".
 *
 * Root cause: the Bedrock provider only emits `reasoning-start` inside the
 * text delta branch. When claude-opus-4-7 (and other Claude models with
 * adaptive thinking enabled) produce an empty thinking block — adaptive
 * thinking with no reasoning text — only a signature delta arrives,
 * skipping `reasoning-start` entirely.
 *
 * Fix: inject a synthetic `reasoning-start` before the first
 * `reasoning-delta` or `reasoning-end` for any ID that hasn't had a
 * `reasoning-start` yet. Also close any unclosed reasoning blocks on
 * stream flush.
 */
export class ReasoningStreamFixMiddleware implements KernelModelMiddleware {
  create(): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();

        const startedIds = new Set<string>();

        return {
          stream: stream.pipeThrough(
            new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
              transform(chunk, controller) {
                if (chunk.type === 'reasoning-start') {
                  startedIds.add(chunk.id);
                  controller.enqueue(chunk);
                  return;
                }

                if (
                  (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning-end') &&
                  !startedIds.has(chunk.id)
                ) {
                  controller.enqueue({ type: 'reasoning-start', id: chunk.id });
                  startedIds.add(chunk.id);
                }

                if (chunk.type === 'reasoning-end') {
                  startedIds.delete(chunk.id);
                }

                controller.enqueue(chunk);
              },
              flush(controller) {
                for (const id of startedIds) {
                  controller.enqueue({ type: 'reasoning-end', id });
                }
              },
            }),
          ),
          ...rest,
        };
      },
    };
  }
}
