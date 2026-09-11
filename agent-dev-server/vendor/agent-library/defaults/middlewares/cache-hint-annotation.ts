/**
 * Cache stability hint annotation for messages.
 *
 * Marks messages as stable or unstable for prompt cache breakpoint placement.
 * System, user, text-only assistant, and already-compacted messages → stable.
 * Messages with uncompacted tool results → unstable.
 */
import type { LanguageModelV3Prompt, LanguageModelV3ToolCallPart } from '@ai-sdk/provider';
import { setCacheHint } from '../../cache/metadata/cache-hints.ts';
import { isToolCallPart, isToolResultPart } from '../../kernel/utils/message-parts.ts';
import { isStoredReference } from './tool-result-compaction.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CacheHintConfig {
  /** Tool names that should always be marked stable (never compacted). */
  neverTruncateToolNames: string[];
}

export const DEFAULT_CACHE_HINT_CONFIG: CacheHintConfig = {
  neverTruncateToolNames: [],
};

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

/**
 * Marks messages with cache stability hints.
 * System, user, text-only assistant, already-compacted → stable.
 * Uncompacted tool results → unstable (will change on next compaction).
 */
export function annotateCacheHints(prompt: LanguageModelV3Prompt, config: CacheHintConfig): void {
  const neverSet = new Set(config.neverTruncateToolNames ?? []);

  for (const msg of prompt) {
    if (msg.role === 'system') {
      setCacheHint(msg, { stable: true, reason: 'system' });
      continue;
    }
    if (msg.role === 'user') {
      setCacheHint(msg, { stable: true, reason: 'user' });
      continue;
    }
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
        setCacheHint(msg, { stable: true, reason: 'text-only' });
        continue;
      }

      const toolParts = msg.content.filter((p) => isToolCallPart(p) || isToolResultPart(p));
      if (toolParts.length === 0) {
        setCacheHint(msg, { stable: true, reason: 'text-only' });
        continue;
      }

      const callPart = toolParts.find((p) => isToolCallPart(p)) as
        | LanguageModelV3ToolCallPart
        | undefined;
      if (callPart && neverSet.has(callPart.toolName)) {
        setCacheHint(msg, { stable: true, reason: 'preserved-tool' });
        continue;
      }

      const resultParts = toolParts.filter((p) => isToolResultPart(p));
      if (resultParts.length === 0) {
        setCacheHint(msg, { stable: true, reason: 'tool-call-only' });
        continue;
      }

      const isCompacted = resultParts.some(
        (part) => isToolResultPart(part) && isStoredReference(part.output),
      );
      setCacheHint(
        msg,
        isCompacted ? { stable: true, reason: 'already-truncated' } : { stable: false },
      );
    }
  }
}
