/**
 * Content builder — converts ModelMessages into PersistedContentItems.
 *
 * Called at natural boundaries in the agent tool loop (model call complete,
 * tool execution complete) to build the finalized UI content for CONTENT#
 * persistence.
 *
 * Content items are produced from:
 * - User messages → text content item
 * - Assistant messages → text content item
 * - Tool/system messages → no content items (component tools persist their
 *   own UI state via `uiProps`, captured from the live content stream by
 *   `SessionManager.recordContent` — see session-manager.ts)
 */

import { generateShortId } from '../types/id.ts';
import type { PersistedContentItem } from './types.ts';
import { isSystemAuthored } from '../kernel/utils/message-parts.ts';

/**
 * Build content items from a single ModelMessage.
 *
 * @param msg - An AI SDK ModelMessage (role + content)
 * @param responseId - The response ID for this agent turn
 */
/** Durable content id supplied by whoever injected the message, when it owns one. */
function contentMessageId(msg: Record<string, unknown>): string | null {
  const providerOptions = msg.providerOptions as Record<string, unknown> | undefined;
  const agentplace = providerOptions?.agentplace as Record<string, unknown> | undefined;
  const id = agentplace?.contentMessageId;
  return typeof id === 'string' && id ? id : null;
}

export function buildContentItems(
  msg: Record<string, unknown>,
  responseId: string | undefined,
): PersistedContentItem[] {
  if (isSystemAuthored(msg as never)) {
    return [];
  }

  const role = msg.role as string;
  if (role === 'tool' || role === 'system') {
    return [];
  }

  const items: PersistedContentItem[] = [];

  if (role === 'user') {
    const raw = extractText(msg);
    const text = raw ? stripModelOnlyContext(raw) : null;
    if (text) {
      items.push({
        messageId: contentMessageId(msg) ?? generateShortId(8),
        responseId,
        role: 'user',
        type: 'text',
        text,
      });
    }
    return items;
  }

  if (role === 'assistant') {
    const content = msg.content;
    if (!Array.isArray(content)) {
      if (typeof content === 'string' && content) {
        items.push({
          messageId: generateShortId(8),
          responseId,
          role: 'assistant',
          type: 'text',
          text: content,
        });
      }
      return items;
    }

    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        items.push({
          messageId: generateShortId(8),
          responseId,
          role: 'assistant',
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
        items.push({
          messageId: generateShortId(8),
          responseId,
          role: 'assistant',
          type: 'text',
          text: part.text,
          isReasoning: true,
        });
      }
    }
  }

  return items;
}

/** Extract plain text from a ModelMessage's content field. */
function extractText(msg: Record<string, unknown>): string | null {
  if (typeof msg.content === 'string') {
    return msg.content || null;
  }
  if (Array.isArray(msg.content)) {
    const textParts = (msg.content as Array<Record<string, unknown>>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text as string)
      .filter(Boolean);
    return textParts.length > 0 ? textParts.join('') : null;
  }
  return null;
}

/**
 * Strip framework-injected context blocks from raw user/assistant text so the
 * persisted/replayed record shows what the human actually wrote, not the
 * model's working context.
 */
export function stripModelOnlyContext(text: string): string {
  return text
    .replace(/<internal_request_metadata>[\s\S]*?<\/internal_request_metadata>\n[^\n]*/g, '')
    .replace(/<ui_action>[\s\S]*?<\/ui_action>\n[^\n]*/g, '')
    .replace(/<actions_since_last_message>[\s\S]*?<\/actions_since_last_message>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}
