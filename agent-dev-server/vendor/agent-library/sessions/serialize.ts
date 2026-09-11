import type { ModelMessage } from '@ai-sdk/provider-utils';
import { stampMessageId } from '../core/agent-state.ts';
import { markPendingResults } from '../core/blocking.ts';
import type { ConversationMessage } from './types.ts';

export interface PersistMeta {
  responseId: string | null;
  pendingToolCallIds: string[];
}

/**
 * Compose persistable ConversationMessage records from raw model output + agent
 * metadata. The WRITE half of persistence serialization (read half:
 * reconstructPendingFromHistory + SessionManager reconstruction). Matches the
 * prior commit-time shape exactly: stamps pending markers in place, wraps each
 * message with role/timestamp/data, and attaches responseId when present.
 */
export function toPersistableMessages(
  messages: ModelMessage[],
  meta: PersistMeta,
): ConversationMessage[] {
  markPendingResults(messages, new Set(meta.pendingToolCallIds));
  for (const message of messages) {
    stampMessageId(message);
  }
  return messages.map((msg) => {
    const role = (msg as { role?: string }).role ?? 'assistant';
    const record: ConversationMessage = {
      role: role as ConversationMessage['role'],
      timestamp: new Date().toISOString(),
      data: msg,
    };
    if (meta.responseId) {
      record.responseId = meta.responseId;
    }
    return record;
  });
}
