/**
 * Typed extractors for AI SDK V3 message content parts.
 *
 * Single source of truth for part-type logic. Consumers use these
 * instead of repeating if-else chains over part.type.
 */

import type { LanguageModelV3Message } from '@ai-sdk/provider';
import type { ModelMessage } from '@ai-sdk/provider-utils';

// ============================================================================
// Part type guards
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: AI SDK V3 message parts are loosely typed
type AnyPart = any;

export function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return !!part && typeof part === 'object' && (part as AnyPart).type === 'text';
}

export function isReasoningPart(part: unknown): part is { type: 'reasoning'; text: string } {
  return !!part && typeof part === 'object' && (part as AnyPart).type === 'reasoning';
}

export function isToolCallPart(
  part: unknown,
): part is { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } {
  return !!part && typeof part === 'object' && (part as AnyPart).type === 'tool-call';
}

export function isToolResultPart(part: unknown): part is {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: string; value?: unknown };
} {
  return !!part && typeof part === 'object' && (part as AnyPart).type === 'tool-result';
}

// ============================================================================
// Content extractors
// ============================================================================

function getParts(msg: LanguageModelV3Message): unknown[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content;
}

/** Extract concatenated text from all text parts in a message. Handles string content too. */
export function getTextContent(msg: LanguageModelV3Message): string {
  // biome-ignore lint/suspicious/noExplicitAny: some messages use plain string content
  const content = (msg as AnyPart).content;
  if (typeof content === 'string') return content;
  return getParts(msg)
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n');
}

/** Extract concatenated reasoning/thinking content. */
export function getReasoningContent(msg: LanguageModelV3Message): string {
  return getParts(msg)
    .filter(isReasoningPart)
    .map((p) => p.text)
    .join('\n');
}

/** Extract all tool-call parts. */
export function getToolCalls(
  msg: LanguageModelV3Message,
): Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> {
  return getParts(msg).filter(isToolCallPart);
}

/** Extract all tool-result parts. */
export function getToolResults(msg: LanguageModelV3Message): Array<{
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: string; value?: unknown };
}> {
  return getParts(msg).filter(isToolResultPart);
}

/** Extract string value from a tool result output. Returns null for binary/non-extractable. */
export function getToolResultString(output: { type: string; value?: unknown }): string | null {
  if (
    (output.type === 'text' || output.type === 'error-text') &&
    typeof output.value === 'string'
  ) {
    return output.value;
  }
  if (output.type === 'json' || output.type === 'error-json') {
    try {
      return JSON.stringify(output.value);
    } catch {
      return null;
    }
  }
  if (
    output.value instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(output.value))
  ) {
    return null;
  }
  return null;
}

/** Detect data-URI or base64 strings that are meaningless as summary text. */
export function looksLikeBinaryString(s: string): boolean {
  if (s.startsWith('data:')) return true;
  if (s.length < 200) return false;
  return /^[A-Za-z0-9+/=\s]{200,}$/.test(s.slice(0, 500));
}

// ============================================================================
// providerOptions helpers
// ============================================================================

/** Get agentplace metadata from message providerOptions. */
export function getAgentplaceMetadata(
  msg: LanguageModelV3Message | ModelMessage,
): Record<string, unknown> | null {
  const opts = (msg as AnyPart).providerOptions;
  if (!opts || typeof opts !== 'object') return null;
  const agentplace = (opts as Record<string, unknown>).agentplace;
  if (!agentplace || typeof agentplace !== 'object') return null;
  return agentplace as Record<string, unknown>;
}

/**
 * Whether a message was authored by the system rather than by the user.
 *
 * `injected` answers a different question — *did this message open a turn?* —
 * and only `groupIntoTurns` should read it. Two other concerns need authorship
 * instead: whether the message is user-visible content (`buildContentItems`)
 * and whether it counts as a real message to compact after
 * (`compaction.middleware`). A steered user message is injected mid-turn yet
 * user-authored, so it answers those two the opposite way from system boundary
 * context — which is why one boolean cannot serve all three.
 *
 * Legacy data needs no migration: `injected` has only ever been set by
 * system-authored injections (boundary context, compaction summaries), so an
 * injected message with no recorded authorship is unambiguously system's. A
 * user-authored injection must therefore mark itself `authored: 'user'`
 * explicitly — absent, the legacy branch would classify it as system's and it
 * would vanish from the UI.
 */
export function isSystemAuthored(msg: LanguageModelV3Message | ModelMessage): boolean {
  const meta = getAgentplaceMetadata(msg);
  if (meta?.authored === 'system') return true;
  if (meta?.authored === 'user') return false;
  return meta?.injected === true;
}

/** Check if message has a specific agentplace type marker. */
export function hasAgentplaceType(
  msg: LanguageModelV3Message | ModelMessage,
  type: string,
): boolean {
  const meta = getAgentplaceMetadata(msg);
  return meta?.type === type;
}
