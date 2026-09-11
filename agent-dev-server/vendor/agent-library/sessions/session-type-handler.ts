/**
 * SessionTypeHandler — per-type behavior for sessions.
 *
 * Each session type (web, api, channel, trigger, webhook, schedule) gets its own
 * handler that controls type-specific rules: naming, future policies, etc.
 *
 * SessionManager delegates to the handler for the session's type.
 * Entry points register their handler via SessionManager or pass it through Agent input.
 */

import type { SessionSummary, SessionType, ConversationMessage } from './types.ts';

/**
 * Abstract base — subclass per session type.
 * Default implementations are safe no-ops so new types only override what they need.
 */
export abstract class SessionTypeHandler {
  abstract readonly type: SessionType;

  /**
   * Called on each user message append. Return a new name string to update,
   * or undefined to leave the current name unchanged.
   *
   * Override per type:
   * - Web: return latest message text (always update)
   * - API: return text only if no name yet (set once)
   * - Channel/Trigger/Webhook/Schedule: return undefined (name set at creation)
   * - Custom: summarize first N messages, then return undefined
   */
  resolveSessionName(
    _summary: SessionSummary,
    _message: ConversationMessage,
  ): string | undefined | Promise<string | undefined> {
    return undefined;
  }
}

// -- Utility used by naming handlers --

const MAX_SESSION_NAME_LENGTH = 80;

/** Extract plain text from an AI SDK ModelMessage data field. */
export function extractTextFromMessageData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const content = (data as Record<string, unknown>).content;

  let raw: string | undefined;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') {
          raw = text;
          break;
        }
      }
    }
  }

  if (!raw) {
    return undefined;
  }

  // Strip leading XML-like metadata tags: <tag_name>...</tag_name>
  const stripped = raw
    .replace(/^(\s*<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*?<\/[a-zA-Z_][a-zA-Z0-9_-]*>\s*)+/, '')
    .trim();
  return stripped || undefined;
}

/** Truncate to MAX_SESSION_NAME_LENGTH, trimming at word boundary.
 *  Uses code-point-aware iteration to avoid splitting multi-byte characters (emoji, CJK). */
export function truncateSessionName(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Use spread to count code points (not UTF-16 code units)
  const codePoints = [...cleaned];
  if (codePoints.length <= MAX_SESSION_NAME_LENGTH) {
    return cleaned;
  }
  const truncated = codePoints.slice(0, MAX_SESSION_NAME_LENGTH).join('');
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > MAX_SESSION_NAME_LENGTH * 0.6) {
    return `${truncated.slice(0, lastSpace)}…`;
  }
  return `${truncated}…`;
}

// -- Built-in handlers --

/** Web sessions: always update name to the latest user message.
 *  When the current name is from the hidden welcome message, the first
 *  assistant response replaces it so the sidebar shows something meaningful. */
export class WebSessionHandler extends SessionTypeHandler {
  readonly type = 'web' as const;

  resolveSessionName(summary: SessionSummary, message: ConversationMessage): string | undefined {
    if (message.role === 'assistant') {
      // Replace only if the current name is the hidden metadata instruction
      if (summary.name?.startsWith('Treat this metadata as internal context')) {
        return extractTextFromMessageData(message.data);
      }
      return undefined;
    }
    return extractTextFromMessageData(message.data);
  }
}

/** API sessions: set name from first user message only. */
export class ApiSessionHandler extends SessionTypeHandler {
  readonly type = 'api' as const;

  resolveSessionName(summary: SessionSummary, message: ConversationMessage): string | undefined {
    if (summary.name || message.role !== 'user') {
      return undefined;
    }
    return extractTextFromMessageData(message.data);
  }
}

/** Channel sessions: name set at creation by ChannelHandler, never auto-updated. */
export class ChannelSessionHandler extends SessionTypeHandler {
  readonly type = 'channel' as const;
}

/** Trigger sessions: name set at creation from trigger event, never auto-updated. */
export class TriggerSessionHandler extends SessionTypeHandler {
  readonly type = 'trigger' as const;
}

/** Schedule sessions: name set at creation from schedule config, never auto-updated. */
export class ScheduleSessionHandler extends SessionTypeHandler {
  readonly type = 'schedule' as const;
}

/** Agent-to-agent sessions: name set at creation, never auto-updated. */
export class AgentSessionHandler extends SessionTypeHandler {
  readonly type = 'agent' as const;
}

// -- Registry --

/** Default handler registry. Covers all built-in session types. */
export function createDefaultHandlers(): Map<SessionType, SessionTypeHandler> {
  const handlers: SessionTypeHandler[] = [
    new WebSessionHandler(),
    new ApiSessionHandler(),
    new ChannelSessionHandler(),
    new TriggerSessionHandler(),
    new ScheduleSessionHandler(),
    new AgentSessionHandler(),
  ];
  return new Map(handlers.map((h) => [h.type, h]));
}
