/**
 * AI SDK → OpenAI Responses API prompt conversion.
 *
 * Internal module — not exported from the library's public API.
 * Used only by OpenAICountTokensEstimator.
 *
 * Converts to the OpenAI Responses API input format, which is used by
 * the /v1/responses/input_tokens endpoint for token counting.
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3DataContent,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';

// =============================================================================
// OpenAI Responses API types (subset for input_tokens counting)
// =============================================================================

type OpenAIInputText = { type: 'input_text'; text: string };
type OpenAIInputImage = { type: 'input_image'; image_url: string };
type OpenAIInputFile = { type: 'input_file'; file_data: string };
type OpenAIOutputText = { type: 'output_text'; text: string };
type OpenAIFunctionCall = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};
type OpenAIFunctionCallOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};
type OpenAIMessage = {
  type: 'message';
  role: 'developer' | 'user' | 'assistant';
  content: Array<OpenAIInputText | OpenAIInputImage | OpenAIInputFile | OpenAIOutputText>;
};
type OpenAIInputItem = OpenAIMessage | OpenAIFunctionCall | OpenAIFunctionCallOutput;
type OpenAIFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
};

export type OpenAIInputTokensParams = {
  model: string;
  input: OpenAIInputItem[];
  tools?: OpenAIFunctionTool[];
};

// =============================================================================
// Data helpers
// =============================================================================

function isUrl(data: LanguageModelV3DataContent): boolean {
  return data instanceof URL || (typeof data === 'string' && /^https?:\/\//i.test(data));
}

function toDataUri(data: LanguageModelV3DataContent, mediaType: string): string {
  if (data instanceof URL) return data.toString();
  if (typeof data === 'string') {
    if (/^https?:\/\//i.test(data)) return data;
    // Assume base64
    return `data:${mediaType};base64,${data}`;
  }
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
  }
  return '';
}

function toUrlString(data: LanguageModelV3DataContent): string {
  return data instanceof URL ? data.toString() : (data as string);
}

// =============================================================================
// Tool result serialization
// =============================================================================

function serializeToolOutput(output: LanguageModelV3ToolResultOutput): string {
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
      // Flatten content parts to text for the output string
      const parts: string[] = [];
      for (const part of output.value) {
        switch (part.type) {
          case 'text':
            parts.push(part.text);
            break;
          // image-data, image-url, file-data, file-url: not representable as tool output text — skip
        }
      }
      return parts.join('\n') || '';
    }
    default:
      return '';
  }
}

// =============================================================================
// Main export
// =============================================================================

/**
 * Convert an AI SDK prompt to OpenAI Responses API input_tokens request params.
 *
 * Returns null if the result has no input items (e.g. empty prompt),
 * which the caller treats as a signal to fall back to heuristic estimation.
 */
export function buildOpenAIInputTokensParams(
  prompt: LanguageModelV3Prompt,
  tools: LanguageModelV3CallOptions['tools'],
  model: string,
): OpenAIInputTokensParams | null {
  const input: OpenAIInputItem[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        input.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: message.content }],
        });
        break;
      }

      case 'user': {
        const content: Array<OpenAIInputText | OpenAIInputImage | OpenAIInputFile> = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            content.push({ type: 'input_text', text: part.text });
          } else if (part.type === 'file') {
            if (part.mediaType.startsWith('image/')) {
              const url = isUrl(part.data)
                ? toUrlString(part.data)
                : toDataUri(part.data, part.mediaType);
              content.push({ type: 'input_image', image_url: url });
            } else {
              const dataUri = isUrl(part.data)
                ? toUrlString(part.data)
                : toDataUri(part.data, part.mediaType);
              content.push({ type: 'input_file', file_data: dataUri });
            }
          }
        }
        if (content.length > 0) {
          input.push({ type: 'message', role: 'user', content });
        }
        break;
      }

      case 'assistant': {
        const content: OpenAIOutputText[] = [];
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              content.push({ type: 'output_text', text: part.text });
              break;
            case 'tool-call':
              // Tool calls are top-level items, not inside message content
              // Push accumulated text first, then tool calls
              if (content.length > 0) {
                input.push({ type: 'message', role: 'assistant', content: [...content] });
                content.length = 0;
              }
              input.push({
                type: 'function_call',
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
              });
              break;
            // reasoning, file, tool-result in assistant: skip
          }
        }
        if (content.length > 0) {
          input.push({ type: 'message', role: 'assistant', content });
        }
        break;
      }

      case 'tool': {
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            input.push({
              type: 'function_call_output',
              call_id: part.toolCallId,
              output: serializeToolOutput(part.output),
            });
          }
        }
        break;
      }
    }
  }

  if (input.length === 0) return null;

  const openaiTools = tools
    ?.filter((t) => t.type === 'function')
    .map((t) => ({
      type: 'function' as const,
      name: t.name,
      ...(t.description && { description: t.description }),
      ...(t.inputSchema && { parameters: t.inputSchema }),
    }));

  return {
    model,
    input,
    ...(openaiTools && openaiTools.length > 0 && { tools: openaiTools }),
  };
}
