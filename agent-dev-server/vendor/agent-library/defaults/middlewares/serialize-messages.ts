import type { LanguageModelV3Message } from '@ai-sdk/provider';
import {
  getTextContent,
  getReasoningContent,
  getToolCalls,
  getToolResults,
  getToolResultString,
} from '../../kernel/utils/message-parts.ts';
import { COMPACTION_MARKER_PREFIXES } from './tool-result-compaction.ts';

const MAX_CHARS = 2000;

function truncate(text: string, limit = MAX_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

/**
 * Serializes messages into human-readable text for the LLM summarizer.
 * Uses extractors from message-parts.ts — no direct access to msg.content parts.
 */
export function serializeMessagesForSummary(messages: LanguageModelV3Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'user': {
        const text = getTextContent(msg);
        if (text) lines.push(`[User] ${text}`);
        break;
      }
      case 'assistant': {
        const thinking = getReasoningContent(msg);
        if (thinking) lines.push(`[Assistant thinking] ${truncate(thinking)}`);
        const text = getTextContent(msg);
        if (text) lines.push(`[Assistant] ${text}`);
        for (const call of getToolCalls(msg)) {
          const inputStr = JSON.stringify(call.input ?? {});
          lines.push(`[Tool call: ${call.toolName}] ${truncate(inputStr, 500)}`);
        }
        break;
      }
      case 'tool': {
        for (const result of getToolResults(msg)) {
          const outputStr = getToolResultString(result.output);
          lines.push(`[Tool result] ${truncate(outputStr ?? '(binary)')}`);
        }
        break;
      }
    }
  }

  return lines.join('\n');
}

const NARRATIVE_REASONING_MAX_CHARS = 200;
const NARRATIVE_TOOL_INPUT_MAX_CHARS = 500;

/**
 * Serialize messages for the compaction summarizer with narrative focus.
 * Tool results are replaced with short labels (the summarizer needs the
 * conversation flow, not the data). Reasoning is heavily truncated.
 */
export function serializeMessagesForNarrative(messages: LanguageModelV3Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        break;

      case 'user': {
        const text = getTextContent(msg);
        if (text) lines.push(`[User] ${text}`);
        break;
      }

      case 'assistant': {
        const reasoning = getReasoningContent(msg);
        if (reasoning) {
          const truncated =
            reasoning.length > NARRATIVE_REASONING_MAX_CHARS
              ? reasoning.slice(0, NARRATIVE_REASONING_MAX_CHARS) + '...'
              : reasoning;
          lines.push(`[Assistant thinking] ${truncated}`);
        }

        const text = getTextContent(msg);
        if (text) lines.push(`[Assistant] ${text}`);

        for (const tc of getToolCalls(msg)) {
          const inputStr = JSON.stringify(tc.input ?? {});
          const truncatedInput =
            inputStr.length > NARRATIVE_TOOL_INPUT_MAX_CHARS
              ? inputStr.slice(0, NARRATIVE_TOOL_INPUT_MAX_CHARS) + '...'
              : inputStr;
          lines.push(`[Tool call: ${tc.toolName}] ${truncatedInput}`);
        }
        break;
      }

      case 'tool': {
        for (const tr of getToolResults(msg)) {
          const outputStr = getToolResultString(tr.output);
          if (outputStr && COMPACTION_MARKER_PREFIXES.some((p) => outputStr.startsWith(p))) {
            // Already a compact reference (stored/truncated/binary marker) — keep as-is.
            lines.push(`[Tool result: ${tr.toolName}] ${outputStr}`);
          } else if (outputStr === null) {
            lines.push(`[Tool result: ${tr.toolName}] (binary)`);
          } else {
            // The summarizer needs the conversation flow, not the data — collapse it.
            lines.push(`[Tool result: ${tr.toolName}] (content collapsed)`);
          }
        }
        break;
      }
    }
  }

  return lines.join('\n');
}
