import type {
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider';
import type { ModelMessage } from '@ai-sdk/provider-utils';

export function isToolCallPart(part: unknown): part is LanguageModelV3ToolCallPart {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool-call';
}

export function isToolResultPart(part: unknown): part is LanguageModelV3ToolResultPart {
  return !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool-result';
}

interface MessageWithRole {
  role: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

type TurnOf<T> = {
  requests: T[];
  responses: T[];
};

function groupByTurn<T extends MessageWithRole>(
  messages: readonly T[],
): {
  systemMessages: T[];
  turns: TurnOf<T>[];
} {
  if (!messages?.length) {
    return { systemMessages: [], turns: [] };
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const turns: TurnOf<T>[] = [];
  let lastRole: string | null = null;

  for (const msg of nonSystem) {
    // Injected user messages are transparent to turn
    // grouping — they go into responses and do NOT update lastRole, so a real
    // user message immediately after still creates a new turn.
    const isInjected = msg.role === 'user' && msg.providerOptions?.agentplace?.injected === true;

    if (isInjected) {
      if (turns.length === 0) {
        turns.push({ requests: [], responses: [] });
      }
      turns[turns.length - 1]!.responses.push(msg);
      continue;
    }

    if (msg.role === 'user') {
      if (lastRole !== 'user') {
        turns.push({ requests: [], responses: [] });
      }
      turns[turns.length - 1]!.requests.push(msg);
    } else {
      if (turns.length === 0) {
        turns.push({ requests: [], responses: [] });
      }
      turns[turns.length - 1]!.responses.push(msg);
    }
    lastRole = msg.role;
  }

  return { systemMessages, turns };
}

function flattenGenericTurns<T>(turns: TurnOf<T>[]): T[] {
  return turns.reduce((acc: T[], t) => acc.concat(t.requests, t.responses), []);
}

/**
 * An injected message is orphaned if it's not adjacent to any assistant message.
 * After turns are dropped, reminders that were between tool pairs may now sit
 * between two user messages or at the edge of the conversation.
 */
/** Limits a prompt to the last N turns, keeping all system messages. */
export function limitPromptByTurns(
  prompt: LanguageModelV3Prompt,
  turnsLimit: number,
): LanguageModelV3Prompt {
  if (!prompt?.length) {
    return [];
  }
  if (!turnsLimit || turnsLimit <= 0) {
    return prompt;
  }

  const { systemMessages, turns } = groupByTurn(prompt);
  const sliced = flattenGenericTurns(turns.slice(-turnsLimit));

  return systemMessages.length ? [...systemMessages, ...sliced] : sliced;
}
