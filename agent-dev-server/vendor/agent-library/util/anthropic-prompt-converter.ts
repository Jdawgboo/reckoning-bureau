/**
 * AI SDK → Anthropic count_tokens prompt conversion.
 *
 * Internal module — not exported from the library's public API.
 * Used only by AnthropicCountTokensEstimator.
 *
 * Follows the same groupIntoBlocks pattern as the private
 * @ai-sdk/anthropic/src/convert-to-anthropic-messages-prompt.ts,
 * without cache control, citations, beta tracking, or tool name mapping.
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3DataContent,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';

// =============================================================================
// Local Anthropic block types (subset of MessageCountTokensParams)
// =============================================================================

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string };
};
type AnthropicDocumentBlock = {
  type: 'document';
  source:
    | { type: 'url'; url: string }
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'text'; media_type: string; data: string };
};
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
};
type AnthropicThinkingBlock = { type: 'thinking'; thinking: string; signature: string };
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

export type CountTokensParams = {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema: unknown }[];
  thinking?: { type: 'enabled'; budget_tokens: number };
};

// =============================================================================
// Helpers
// =============================================================================

function extractReasoningSignature(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): string | undefined {
  if (providerOptions == null) return undefined;
  for (const key of ['anthropic', 'bedrock']) {
    const meta = providerOptions[key];
    if (meta != null && typeof meta === 'object' && typeof meta['signature'] === 'string') {
      return meta['signature'];
    }
  }
  return undefined;
}

// =============================================================================
// Block grouping — matches @ai-sdk/anthropic's internal groupIntoBlocks logic.
// Consecutive 'user' and 'tool' messages collapse into a single UserBlock
// because Anthropic requires tool results inside a user-role message.
// =============================================================================

type SystemBlock = { type: 'system'; messages: Array<LanguageModelV3Message & { role: 'system' }> };
type AssistantBlock = {
  type: 'assistant';
  messages: Array<LanguageModelV3Message & { role: 'assistant' }>;
};
type UserBlock = {
  type: 'user';
  messages: Array<LanguageModelV3Message & { role: 'user' | 'tool' }>;
};
type MessageBlock = SystemBlock | AssistantBlock | UserBlock;

function groupIntoBlocks(prompt: LanguageModelV3Prompt): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let current: MessageBlock | undefined;

  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        if (current?.type !== 'system') {
          current = { type: 'system', messages: [] };
          blocks.push(current);
        }
        (current as SystemBlock).messages.push(message);
        break;
      case 'assistant':
        if (current?.type !== 'assistant') {
          current = { type: 'assistant', messages: [] };
          blocks.push(current);
        }
        (current as AssistantBlock).messages.push(message);
        break;
      case 'user':
      case 'tool':
        if (current?.type !== 'user') {
          current = { type: 'user', messages: [] };
          blocks.push(current);
        }
        (current as UserBlock).messages.push(
          message as LanguageModelV3Message & { role: 'user' | 'tool' },
        );
        break;
    }
  }

  return blocks;
}

// =============================================================================
// File conversion helpers
// =============================================================================

function isUrl(data: LanguageModelV3DataContent): boolean {
  return data instanceof URL || (typeof data === 'string' && /^https?:\/\//i.test(data));
}

function toUrlString(data: LanguageModelV3DataContent): string {
  return data instanceof URL ? data.toString() : (data as string);
}

function toBase64(data: string | Uint8Array): string {
  if (typeof data === 'string') return data;
  return Buffer.from(data).toString('base64');
}

function toText(data: string | Uint8Array): string {
  if (typeof data === 'string') return data;
  return new TextDecoder().decode(data);
}

function convertFileToBlock(
  data: LanguageModelV3DataContent,
  mediaType: string,
): AnthropicImageBlock | AnthropicDocumentBlock | null {
  if (mediaType.startsWith('image/')) {
    return isUrl(data)
      ? { type: 'image', source: { type: 'url', url: toUrlString(data) } }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType === 'image/*' ? 'image/jpeg' : mediaType,
            data: toBase64(data as string | Uint8Array),
          },
        };
  }

  if (mediaType === 'application/pdf') {
    return isUrl(data)
      ? { type: 'document', source: { type: 'url', url: toUrlString(data) } }
      : {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: toBase64(data as string | Uint8Array),
          },
        };
  }

  if (mediaType === 'text/plain') {
    return isUrl(data)
      ? { type: 'document', source: { type: 'url', url: toUrlString(data) } }
      : {
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: toText(data as string | Uint8Array),
          },
        };
  }

  // Other media types have no Anthropic equivalent — skip
  return null;
}

// =============================================================================
// Tool result serialization
// =============================================================================

function serializeToolOutput(
  output: LanguageModelV3ToolResultOutput,
): string | AnthropicContentBlock[] {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'execution-denied':
      return output.reason ?? 'Tool execution denied.';
    case 'content': {
      const blocks: AnthropicContentBlock[] = [];
      for (const part of output.value) {
        switch (part.type) {
          case 'text':
            blocks.push({ type: 'text', text: part.text });
            break;
          case 'image-data':
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: part.mediaType, data: part.data },
            });
            break;
          case 'image-url':
            blocks.push({
              type: 'image',
              source: { type: 'url', url: part.url },
            });
            break;
          case 'file-data':
            if ((part.mediaType as string).startsWith('image/')) {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.mediaType as string,
                  data: part.data as string,
                },
              });
            } else if (part.mediaType === 'application/pdf') {
              blocks.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: part.data as string,
                },
              });
            }
            // Other media types: no Anthropic equivalent — skip
            break;
          case 'file-url':
            blocks.push({
              type: 'document',
              source: { type: 'url', url: part.url },
            });
            break;
          // 'file-id' / 'image-file-id': provider file references, no Anthropic count_tokens equivalent — skip
          // 'custom': provider-specific, no mapping — skip
        }
      }
      return blocks.length > 0 ? blocks : '';
    }
    default:
      return '';
  }
}

// =============================================================================
// Main export: AI SDK prompt → Anthropic count_tokens params
// =============================================================================

/**
 * Convert an AI SDK prompt to Anthropic count_tokens request params.
 *
 * Returns null if the result has no messages (e.g. system-only prompt),
 * which the caller treats as a signal to fall back to heuristic estimation.
 */
export function buildCountTokensParams(
  prompt: LanguageModelV3Prompt,
  tools: LanguageModelV3CallOptions['tools'],
  model: string,
): CountTokensParams | null {
  const blocks = groupIntoBlocks(prompt);
  let system: string | undefined;
  const messages: AnthropicMessage[] = [];
  let hasThinkingBlocks = false;

  for (const block of blocks) {
    switch (block.type) {
      case 'system': {
        system = block.messages.map((m) => m.content).join('\n\n');
        break;
      }

      case 'user': {
        const content: AnthropicContentBlock[] = [];

        for (const message of block.messages) {
          if (message.role === 'user') {
            for (const part of message.content) {
              if (part.type === 'text') {
                content.push({ type: 'text', text: part.text });
              } else if (part.type === 'file') {
                const converted = convertFileToBlock(part.data, part.mediaType);
                if (converted) content.push(converted);
              }
            }
          } else if (message.role === 'tool') {
            for (const part of message.content) {
              if (part.type === 'tool-result') {
                content.push({
                  type: 'tool_result',
                  tool_use_id: part.toolCallId,
                  content: serializeToolOutput(part.output),
                });
              }
              // 'tool-approval-response' → skip (no Anthropic equivalent)
            }
          }
        }

        // Guard: Anthropic rejects empty content arrays. If all parts were unsupported
        // file types, add a minimal placeholder so the message structure stays valid.
        if (content.length === 0) content.push({ type: 'text', text: '' });
        messages.push({ role: 'user', content });
        break;
      }

      case 'assistant': {
        const content: AnthropicContentBlock[] = [];

        for (const message of block.messages) {
          for (const part of message.content) {
            switch (part.type) {
              case 'text':
                content.push({ type: 'text', text: part.text });
                break;
              case 'tool-call':
                content.push({
                  type: 'tool_use',
                  id: part.toolCallId,
                  name: part.toolName,
                  input: part.input,
                });
                break;
              case 'reasoning': {
                const signature = extractReasoningSignature(part.providerOptions);
                if (signature !== undefined) {
                  content.push({ type: 'thinking', thinking: part.text, signature });
                  hasThinkingBlocks = true;
                }
                break;
              }
              case 'file':
              case 'tool-result':
                // file/tool-result in assistant position: rare, skip
                break;
            }
          }
        }

        // Guard: an all-reasoning assistant block produces empty content. Anthropic rejects
        // empty content arrays and empty text blocks. Use a minimal non-empty placeholder
        // to preserve message alternation at negligible token cost.
        if (content.length === 0) content.push({ type: 'text', text: '...' });
        messages.push({ role: 'assistant', content });
        break;
      }
    }
  }

  if (messages.length === 0) return null;

  const anthropicTools = tools
    ?.filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema, // camelCase → snake_case
    }));

  return {
    model,
    ...(system !== undefined && { system }),
    messages,
    ...(anthropicTools && anthropicTools.length > 0 && { tools: anthropicTools }),
    ...(hasThinkingBlocks && { thinking: { type: 'enabled', budget_tokens: 16_000 } }),
  };
}
