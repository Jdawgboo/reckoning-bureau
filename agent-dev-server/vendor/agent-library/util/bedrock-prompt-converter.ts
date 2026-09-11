/**
 * AI SDK → Bedrock Converse countTokens prompt conversion.
 *
 * Internal module — not exported from the library's public API.
 * Used only by BedrockCountTokensEstimator.
 *
 * Converts to Amazon Bedrock's Converse format, which is used by
 * the CountTokens API endpoint.
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3DataContent,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';

// =============================================================================
// Bedrock Converse types (subset for CountTokens)
// =============================================================================

type BedrockTextBlock = { text: string };
type BedrockImageBlock = {
  image: {
    format: string;
    source: { bytes: string }; // base64
  };
};
type BedrockDocumentBlock = {
  document: {
    format: string;
    name: string;
    source: { bytes: string }; // base64
  };
};
type BedrockToolUseBlock = {
  toolUse: { toolUseId: string; name: string; input: unknown };
};
type BedrockToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: Array<{ text?: string; image?: BedrockImageBlock['image'] }>;
  };
};
type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockImageBlock
  | BedrockDocumentBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock;

type BedrockMessage = {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
};

export type BedrockCountTokensParams = {
  modelId: string;
  messages: BedrockMessage[];
  system?: BedrockTextBlock[];
  toolConfig?: {
    tools: Array<{
      toolSpec: { name: string; description?: string; inputSchema: { json: unknown } };
    }>;
  };
};

// =============================================================================
// Data helpers
// =============================================================================

function toBase64(data: LanguageModelV3DataContent): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  return '';
}

function isUrl(data: LanguageModelV3DataContent): boolean {
  return data instanceof URL || (typeof data === 'string' && /^https?:\/\//i.test(data));
}

function mediaTypeToFormat(mediaType: string): string {
  // Extract format from MIME type: 'image/png' → 'png', 'application/pdf' → 'pdf'
  const parts = mediaType.split('/');
  return parts[parts.length - 1] ?? 'unknown';
}

// =============================================================================
// Tool result serialization
// =============================================================================

function serializeToolOutput(output: LanguageModelV3ToolResultOutput): Array<{ text?: string }> {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return [{ text: output.value }];
    case 'json':
    case 'error-json':
      return [{ text: JSON.stringify(output.value) }];
    case 'execution-denied':
      return [{ text: output.reason ?? 'Tool execution denied.' }];
    case 'content': {
      const parts: Array<{ text?: string }> = [];
      for (const part of output.value) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        }
        // Images/files in tool results: skip for simplicity in token counting
      }
      return parts.length > 0 ? parts : [{ text: '' }];
    }
    default:
      return [{ text: '' }];
  }
}

// =============================================================================
// Main export
// =============================================================================

/**
 * Convert an AI SDK prompt to Bedrock Converse CountTokens request params.
 *
 * Returns null if the result has no messages (e.g. system-only prompt).
 */
export function buildBedrockCountTokensParams(
  prompt: LanguageModelV3Prompt,
  tools: LanguageModelV3CallOptions['tools'],
  modelId: string,
): BedrockCountTokensParams | null {
  const messages: BedrockMessage[] = [];
  let system: BedrockTextBlock[] | undefined;

  // Bedrock requires alternating user/assistant. Track to merge.
  let lastRole: 'user' | 'assistant' | null = null;

  function getCurrentOrCreate(role: 'user' | 'assistant'): BedrockMessage {
    if (lastRole === role && messages.length > 0) {
      return messages[messages.length - 1];
    }
    const msg: BedrockMessage = { role, content: [] };
    messages.push(msg);
    lastRole = role;
    return msg;
  }

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        if (!system) system = [];
        system.push({ text: message.content });
        break;
      }

      case 'user': {
        const msg = getCurrentOrCreate('user');
        for (const part of message.content) {
          if (part.type === 'text') {
            msg.content.push({ text: part.text });
          } else if (part.type === 'file') {
            if (isUrl(part.data)) {
              msg.content.push({ text: `[file: ${part.mediaType}]` });
            } else if (part.mediaType.startsWith('image/')) {
              msg.content.push({
                image: {
                  format: mediaTypeToFormat(part.mediaType),
                  source: { bytes: toBase64(part.data) },
                },
              } as BedrockImageBlock);
            } else {
              msg.content.push({
                document: {
                  format: mediaTypeToFormat(part.mediaType),
                  name: 'document',
                  source: { bytes: toBase64(part.data) },
                },
              } as BedrockDocumentBlock);
            }
          }
        }
        break;
      }

      case 'assistant': {
        const msg = getCurrentOrCreate('assistant');
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              msg.content.push({ text: part.text });
              break;
            case 'tool-call':
              msg.content.push({
                toolUse: {
                  toolUseId: part.toolCallId,
                  name: part.toolName,
                  input: part.input,
                },
              } as BedrockToolUseBlock);
              break;
            // reasoning, file, tool-result: skip
          }
        }
        // Guard: empty content
        if (msg.content.length === 0) {
          msg.content.push({ text: '' });
        }
        break;
      }

      case 'tool': {
        // Tool results go in a user message in Bedrock Converse
        const msg = getCurrentOrCreate('user');
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            msg.content.push({
              toolResult: {
                toolUseId: part.toolCallId,
                content: serializeToolOutput(part.output),
              },
            } as BedrockToolResultBlock);
          }
        }
        break;
      }
    }
  }

  if (messages.length === 0) return null;

  const bedrockTools = tools
    ?.filter((t) => t.type === 'function')
    .map((t) => ({
      toolSpec: {
        name: t.name,
        ...(t.description && { description: t.description }),
        inputSchema: { json: t.inputSchema ?? {} },
      },
    }));

  return {
    modelId,
    messages,
    ...(system && { system }),
    ...(bedrockTools && bedrockTools.length > 0 && { toolConfig: { tools: bedrockTools } }),
  };
}
