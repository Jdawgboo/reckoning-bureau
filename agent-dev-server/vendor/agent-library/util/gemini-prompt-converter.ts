/**
 * AI SDK → Gemini countTokens prompt conversion.
 *
 * Internal module — not exported from the library's public API.
 * Used only by GeminiCountTokensEstimator.
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3DataContent,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';
import { isRecord } from './type-guards.ts';

// =============================================================================
// Gemini types (subset for countTokens)
// =============================================================================

type GeminiTextPart = { text: string };
type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiFunctionCallPart = { functionCall: { name: string; args: Record<string, unknown> } };
type GeminiFunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> };
};
type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type GeminiCountTokensParams = {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
};

// =============================================================================
// Data helpers
// =============================================================================

function toBase64(data: LanguageModelV3DataContent): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof URL) return ''; // URL not supported for inline data
  return '';
}

function isUrl(data: LanguageModelV3DataContent): boolean {
  return data instanceof URL || (typeof data === 'string' && /^https?:\/\//i.test(data));
}

// =============================================================================
// Tool result serialization
// =============================================================================

function serializeToolOutput(output: LanguageModelV3ToolResultOutput): Record<string, unknown> {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { result: output.value };
    case 'json':
    case 'error-json':
      return typeof output.value === 'object' && output.value !== null
        ? (output.value as Record<string, unknown>)
        : { result: output.value };
    case 'execution-denied':
      return { error: output.reason ?? 'Tool execution denied.' };
    case 'content': {
      const texts: string[] = [];
      for (const part of output.value) {
        if (part.type === 'text') texts.push(part.text);
      }
      return { result: texts.join('\n') || '' };
    }
    default:
      return { result: '' };
  }
}

// =============================================================================
// Tool parameters schema sanitization
// =============================================================================

/**
 * Fields of the Vertex/Gemini OpenAPI Schema proto. Anything else in a
 * zod-generated JSON Schema ($schema, additionalProperties, $ref, allOf, …)
 * makes countTokens reject the whole request with 400 INVALID_ARGUMENT, so
 * sanitization is whitelist-based.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'default',
  'example',
  'anyOf',
]);

/**
 * Reduce a JSON Schema to the subset Gemini's Schema proto accepts.
 * Tuple-form `items` collapses to its first entry; a `type` array
 * (e.g. ['string', 'null']) becomes a single type plus `nullable`.
 * Lossy by design — the result only needs to be valid and roughly
 * token-equivalent for counting, not semantically exact.
 */
function sanitizeParametersSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;

    switch (key) {
      case 'type': {
        if (Array.isArray(value)) {
          const nonNull = value.find((t) => t !== 'null');
          if (typeof nonNull === 'string') result['type'] = nonNull;
          if (value.includes('null')) result['nullable'] = true;
        } else {
          result['type'] = value;
        }
        break;
      }
      case 'properties': {
        if (isRecord(value)) {
          const sanitized: Record<string, unknown> = {};
          for (const [propName, propSchema] of Object.entries(value)) {
            const clean = sanitizeParametersSchema(propSchema);
            if (clean !== undefined) sanitized[propName] = clean;
          }
          result['properties'] = sanitized;
        }
        break;
      }
      case 'items': {
        const first = Array.isArray(value) ? value[0] : value;
        const clean = sanitizeParametersSchema(first);
        if (clean !== undefined) result['items'] = clean;
        break;
      }
      case 'anyOf': {
        if (Array.isArray(value)) {
          const variants = value
            .map((v) => sanitizeParametersSchema(v))
            .filter((v): v is Record<string, unknown> => v !== undefined);
          if (variants.length > 0) result['anyOf'] = variants;
        }
        break;
      }
      default:
        result[key] = value;
    }
  }
  return result;
}

// =============================================================================
// Main export
// =============================================================================

/**
 * Convert an AI SDK prompt to Gemini countTokens request params.
 *
 * Returns null if the result has no contents (empty prompt).
 */
export function buildGeminiCountTokensParams(
  prompt: LanguageModelV3Prompt,
  tools: LanguageModelV3CallOptions['tools'],
): GeminiCountTokensParams | null {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: GeminiTextPart[] } | undefined;

  // Gemini requires alternating user/model turns. Track last role
  // to merge consecutive same-role messages.
  let lastRole: 'user' | 'model' | null = null;

  function getCurrentOrCreate(role: 'user' | 'model'): GeminiContent {
    if (lastRole === role && contents.length > 0) {
      return contents[contents.length - 1];
    }
    const content: GeminiContent = { role, parts: [] };
    contents.push(content);
    lastRole = role;
    return content;
  }

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        if (!systemInstruction) {
          systemInstruction = { parts: [] };
        }
        systemInstruction.parts.push({ text: message.content });
        break;
      }

      case 'user': {
        const content = getCurrentOrCreate('user');
        for (const part of message.content) {
          if (part.type === 'text') {
            content.parts.push({ text: part.text });
          } else if (part.type === 'file') {
            if (isUrl(part.data)) {
              // Gemini supports fileData with URI, but for simplicity skip URL files
              content.parts.push({ text: `[file: ${part.mediaType}]` });
            } else {
              content.parts.push({
                inlineData: {
                  mimeType: part.mediaType,
                  data: toBase64(part.data),
                },
              });
            }
          }
        }
        break;
      }

      case 'assistant': {
        const content = getCurrentOrCreate('model');
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              content.parts.push({ text: part.text });
              break;
            case 'tool-call':
              content.parts.push({
                functionCall: {
                  name: part.toolName,
                  args: (typeof part.input === 'object' && part.input !== null
                    ? part.input
                    : { input: part.input }) as Record<string, unknown>,
                },
              });
              break;
            // reasoning, file, tool-result: skip
          }
        }
        // Guard: Gemini rejects empty parts
        if (content.parts.length === 0) {
          content.parts.push({ text: '' });
        }
        break;
      }

      case 'tool': {
        // Tool results go in a user turn in Gemini
        const content = getCurrentOrCreate('user');
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            content.parts.push({
              functionResponse: {
                name: part.toolName ?? 'unknown',
                response: serializeToolOutput(part.output),
              },
            });
          }
        }
        break;
      }
    }
  }

  if (contents.length === 0) return null;

  const geminiTools = tools
    ?.filter((t) => t.type === 'function')
    .map((t) => {
      const parameters = t.inputSchema ? sanitizeParametersSchema(t.inputSchema) : undefined;
      return {
        name: t.name,
        ...(t.description && { description: t.description }),
        ...(parameters !== undefined && { parameters }),
      };
    });

  return {
    contents,
    ...(systemInstruction && { systemInstruction }),
    ...(geminiTools &&
      geminiTools.length > 0 && {
        tools: [{ functionDeclarations: geminiTools }],
      }),
  };
}
