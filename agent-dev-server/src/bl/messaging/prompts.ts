import dedent from 'dedent';
import type { MemoryEntry } from '../../types';
import { formatRelativeAge } from '../../util/relative-age.ts';

const MAX_MEMORY_ITEMS = 15;

/**
 * Renders the visitor's saved memory-bank notes as a model-facing prompt
 * block, one line per entry prefixed with its relative age (e.g.
 * `- (3 weeks ago) visitor is vegetarian`) so the model can discount stale
 * notes. `now` is injectable for deterministic tests.
 */
export const createMemoryPrompt = (memories: MemoryEntry[], now: number = Date.now()) => {
  if (!memories || memories.length === 0) {
    return '';
  }

  // Sort by timestamp and take only the last N memories to avoid overwhelming the prompt
  const recentMemories = [...memories]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_MEMORY_ITEMS);

  const memoryItems = recentMemories
    .map((m) => `- (${formatRelativeAge(m.timestamp, now)}) ${m.summary}`)
    .join('\n');

  return dedent`
    <user_memory_bank>
    The following information has been remembered about the user from previous conversations.
    Use this context to personalize your responses and provide a more tailored experience:

    ${memoryItems}
    </user_memory_bank>
  `;
};

export const createRealtimePrompt = (
  instruction: string,
  renderedMessages: string,
  memories: MemoryEntry[] = [],
  presentation?: string,
  now: number = Date.now(),
) => dedent`
  ${instruction}
  ${presentation ?? ''}
  ${createMemoryPrompt(memories, now)}
`;
