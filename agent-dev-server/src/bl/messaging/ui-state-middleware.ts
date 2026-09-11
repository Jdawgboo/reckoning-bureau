/**
 * Ephemeral `<ui_state>` injection (A2UI roadmap follow-up).
 *
 * Runs as a model middleware (transformParams, before every model call)
 * instead of being baked into the persisted turn text: the block is read
 * fresh each call and appended to the last user message, so it reflects
 * mid-run uiState writes (e.g. a RenderSurface dataModel seed earlier in the
 * same turn) without ever landing in conversation history.
 */
import type { LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Message } from '@ai-sdk/provider';
import type { KernelModelMiddleware } from '../../../vendor/agent-library/kernel/middlewares/types.ts';

/** Immutably appends `block` to the last user message's text content.
 *  No-op (returns the same array reference) when there is no user message
 *  or the block is empty. Never mutates `prompt` or its messages. */
export function appendToLastUserMessage(
  prompt: LanguageModelV3Message[],
  block: string,
): LanguageModelV3Message[] {
  if (!block) {
    return prompt;
  }
  const lastUserIndex = prompt.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) {
    return prompt;
  }

  const target = prompt[lastUserIndex] as Extract<LanguageModelV3Message, { role: 'user' }>;
  let lastTextIndex = -1;
  target.content.forEach((part, i) => {
    if (part.type === 'text') {
      lastTextIndex = i;
    }
  });

  const nextContent =
    lastTextIndex >= 0
      ? target.content.map((part, i) =>
          i === lastTextIndex && part.type === 'text'
            ? { ...part, text: `${part.text}\n\n${block}` }
            : part,
        )
      : [...target.content, { type: 'text' as const, text: block }];

  const nextMessage = { ...target, content: nextContent };
  return prompt.map((m, i) => (i === lastUserIndex ? nextMessage : m));
}

/** Model middleware factory: reads the ephemeral uiState block fresh on every
 *  model call and appends it to the last user message (not the system
 *  prompt — keeps the volatile block after the cached prefix). */
export function createUiStateMiddleware(readBlock: () => Promise<string>): KernelModelMiddleware {
  return {
    create(): LanguageModelMiddleware {
      return {
        specificationVersion: 'v3',
        transformParams: async ({ params }) => {
          const opts = params as LanguageModelV3CallOptions;
          const block = await readBlock();
          if (!block) {
            return opts;
          }
          return { ...opts, prompt: appendToLastUserMessage(opts.prompt, block) };
        },
      };
    },
  };
}
