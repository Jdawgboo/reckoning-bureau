/**
 * Approximate token estimation for context budget guards.
 *
 * NOT an exact tokenizer — uses chars-per-token heuristics per model family.
 * Intended as a guardrail to prevent grossly oversized prompts (e.g. 900K on 200K budget).
 *
 * Ratios are calibrated conservatively (lower = more tokens estimated = safer).
 * Agent prompts are JSON-heavy (tool calls, structured results, message framing)
 * which tokenize less efficiently than plain prose (~2.9 vs ~4.0 chars/token).
 *
 * Three estimation functions:
 * - estimateTokensDetailed:          JSON.stringify-based, for arbitrary payloads (backward compat)
 * - estimatePromptTokensDetailed:    Walks AI SDK LanguageModelV3Prompt, file-aware (agent-side)
 * - estimateTokensDetailedFileAware: JSON.stringify with replacer, file-aware (gateway-side)
 */

import type { LanguageModelV3DataContent, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { getAgentLogger } from '../types/logger.ts';

export type TokenEstimationResult = {
  tokens: number;
  estimator: string;
  /** Chars-per-token ratio used. Only present for heuristic-based estimators. */
  charsPerToken?: number;
};

type ModelEstimator = {
  pattern: RegExp;
  charsPerToken: number;
  /** Human-readable label for logs */
  name: string;
};

/**
 * Chars-per-token ratios by model family.
 *
 * Calibrated for agent workloads (JSON-heavy: tool calls, structured results,
 * message role framing). Plain prose would be higher (~3.5-4.0), but agent
 * prompts are mostly structured data.
 *
 * Values are intentionally conservative — underestimating chars/token means
 * we overestimate token count, which is safer for budget enforcement.
 *
 * Observed from production Bedrock logs:
 * - Claude with agent JSON: ~2.9 chars/token actual
 * - GPT with agent JSON: ~3.0-3.2 chars/token actual
 */
const MODEL_ESTIMATORS: ModelEstimator[] = [
  // Anthropic Claude family — observed ~2.9 in prod with agent JSON
  { pattern: /claude.*opus/i, charsPerToken: 3.0, name: 'claude-opus' },
  // Sonnet 5's denser tokenizer (~30% more tokens than 4.x) needs a lower ratio.
  // Must precede the generic claude.*sonnet rule, which stays at 3.0 for 4.x.
  { pattern: /claude.*sonnet-5/i, charsPerToken: 2.3, name: 'claude-sonnet-5' },
  { pattern: /claude.*sonnet/i, charsPerToken: 3.0, name: 'claude-sonnet' },
  { pattern: /claude.*haiku/i, charsPerToken: 3.0, name: 'claude-haiku' },
  { pattern: /claude/i, charsPerToken: 3.0, name: 'claude' },

  // OpenAI GPT family — tiktoken
  { pattern: /^gpt/i, charsPerToken: 3.0, name: 'gpt' },

  // OpenAI reasoning models — same tokenizer as GPT
  { pattern: /^o[13]/i, charsPerToken: 3.0, name: 'openai-reasoning' },

  // Google Gemini family — SentencePiece
  { pattern: /gemini/i, charsPerToken: 3.0, name: 'gemini' },

  // xAI Grok family — BPE-based
  { pattern: /grok/i, charsPerToken: 3.0, name: 'grok' },
];

const DEFAULT_ESTIMATOR: Pick<ModelEstimator, 'charsPerToken' | 'name'> = {
  charsPerToken: 3.0,
  name: 'default',
};

function resolveEstimator(
  model: string | undefined,
): Pick<ModelEstimator, 'charsPerToken' | 'name'> {
  if (!model) {
    return DEFAULT_ESTIMATOR;
  }
  for (const estimator of MODEL_ESTIMATORS) {
    if (estimator.pattern.test(model)) {
      return estimator;
    }
  }
  return DEFAULT_ESTIMATOR;
}

/**
 * Estimate token count from a JSON-serializable payload.
 * Returns detailed result with estimator name for logging.
 *
 * @param payload - The data to estimate (prompt array, messages, or any serializable object)
 * @param model   - Model name for model-specific ratio. Falls back to conservative default.
 */
export function estimateTokensDetailed(payload: unknown, model?: string): TokenEstimationResult {
  const { charsPerToken, name } = resolveEstimator(model);
  const chars = JSON.stringify(payload).length;
  return {
    tokens: Math.ceil(chars / charsPerToken),
    estimator: name,
    charsPerToken,
  };
}

/**
 * Estimate token count with model-specific ratio.
 */
export function estimateTokensForModel(payload: unknown, model?: string): number {
  return estimateTokensDetailed(payload, model).tokens;
}

/**
 * Quick per-message token estimate used by findCutPoint in CompactionMiddleware.
 *
 * Strips `providerOptions` before measuring — these carry opaque blobs (e.g.
 * Bedrock reasoning signatures, cache hints) that are never tokenized as content.
 * Without this, a single thinking block can inflate the estimate by 4–5× due to
 * the base64 signature stored in providerOptions.bedrock.signature.
 */
export function estimateTokens(payload: unknown): number {
  const chars = JSON.stringify(payload, (_key, value) =>
    _key === 'providerOptions' ? undefined : value,
  ).length;
  return Math.ceil(chars / DEFAULT_ESTIMATOR.charsPerToken);
}

// =============================================================================
// File-aware prompt estimation (AI SDK LanguageModelV3Prompt)
// =============================================================================

const IMAGE_TOKEN_ESTIMATE = 1500;
const URL_FILE_TOKEN_ESTIMATE = 200;
const MESSAGE_FRAMING_CHARS = 50;

function getDataByteSize(data: LanguageModelV3DataContent): number {
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof URL) return 0;
  if (typeof data === 'string') {
    if (/^https?:\/\//i.test(data)) return 0;
    return Math.floor(data.length * 0.75);
  }
  return 0;
}

function isUrlData(data: LanguageModelV3DataContent): boolean {
  return data instanceof URL || (typeof data === 'string' && /^https?:\/\//i.test(data));
}

function estimateFileTokens(
  data: LanguageModelV3DataContent,
  mediaType: string,
  charsPerToken: number,
): number {
  const logger = getAgentLogger();

  if (isUrlData(data)) {
    logger.warn('[HeuristicTokenEstimator] URL-referenced file — using placeholder estimate', {
      mediaType,
    });
    return URL_FILE_TOKEN_ESTIMATE;
  }

  if (mediaType.startsWith('image/')) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (mediaType === 'application/pdf') {
    const bytes = getDataByteSize(data);
    return Math.ceil(bytes / 100_000) * 2_000;
  }

  if (mediaType === 'text/plain') {
    let text: string;
    if (data instanceof Uint8Array) {
      text = new TextDecoder().decode(data);
    } else if (typeof data === 'string') {
      try {
        const decoded = Buffer.from(data, 'base64').toString('utf-8');
        const printableRatio =
          decoded.length > 0
            ? decoded.replace(/[^\x20-\x7E\n\r\t]/g, '').length / decoded.length
            : 1;
        text = printableRatio > 0.9 ? decoded : data;
      } catch {
        text = data;
      }
    } else {
      text = String(data);
    }
    return Math.ceil(text.length / charsPerToken);
  }

  const bytes = getDataByteSize(data);
  logger.warn('[HeuristicTokenEstimator] Unknown media type — using conservative estimate', {
    mediaType,
    bytes,
  });
  return Math.ceil(bytes / 50) + 500;
}

function estimateToolResultContentTokens(
  value: Array<Record<string, any>>,
  charsPerToken: number,
): { chars: number; fileTokens: number } {
  let chars = 0;
  let fileTokens = 0;

  for (const part of value) {
    switch (part.type) {
      case 'text':
        chars += JSON.stringify(part).length;
        break;
      case 'image-data':
        fileTokens += IMAGE_TOKEN_ESTIMATE;
        break;
      case 'image-url':
        fileTokens += IMAGE_TOKEN_ESTIMATE;
        break;
      case 'file-data': {
        const mediaType = (part.mediaType as string) ?? 'application/octet-stream';
        const dataStr = (part.data as string) ?? '';
        if (mediaType.startsWith('image/')) {
          fileTokens += IMAGE_TOKEN_ESTIMATE;
        } else if (mediaType === 'application/pdf') {
          const bytes = Math.floor(dataStr.length * 0.75);
          fileTokens += Math.ceil(bytes / 100_000) * 2_000;
        } else if (mediaType === 'text/plain') {
          try {
            const decoded = Buffer.from(dataStr, 'base64').toString('utf-8');
            chars += decoded.length;
          } catch {
            chars += dataStr.length;
          }
        } else {
          const bytes = Math.floor(dataStr.length * 0.75);
          fileTokens += Math.ceil(bytes / 50) + 500;
        }
        break;
      }
      case 'file-url':
        fileTokens += URL_FILE_TOKEN_ESTIMATE;
        break;
      default:
        break;
    }
  }

  return { chars, fileTokens };
}

function estimateToolResultOutputTokens(
  output: Record<string, any>,
  charsPerToken: number,
): { chars: number; fileTokens: number } {
  if (!output || typeof output !== 'object') {
    return { chars: 0, fileTokens: 0 };
  }

  if (output.type === 'content' && Array.isArray(output.value)) {
    return estimateToolResultContentTokens(output.value, charsPerToken);
  }

  return { chars: JSON.stringify(output).length, fileTokens: 0 };
}

/**
 * Estimate tokens for a single tool-result output value, file-aware.
 * Used for per-part decisions (e.g. oversized-result neutralization).
 */
export function estimateToolResultPartTokens(output: unknown, model?: string): number {
  const { charsPerToken } = resolveEstimator(model);
  const { chars, fileTokens } = estimateToolResultOutputTokens(
    output as Record<string, any>,
    charsPerToken,
  );
  return Math.ceil(chars / charsPerToken) + fileTokens;
}

type PromptMessage = LanguageModelV3Prompt[number] | { role: string; content: unknown };

function estimateMessageParts(
  message: PromptMessage,
  charsPerToken: number,
): { chars: number; fileTokens: number } {
  let chars = MESSAGE_FRAMING_CHARS;
  let fileTokens = 0;

  if (message.role === 'system') {
    return { chars: chars + (message.content as string).length, fileTokens };
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return { chars: chars + JSON.stringify(content).length, fileTokens };
  }

  for (const part of content) {
    switch ((part as any).type) {
      case 'text':
      case 'tool-call':
        chars += JSON.stringify(part).length;
        break;

      case 'reasoning': {
        // Count only the reasoning text — providerOptions.bedrock.signature / anthropic.signature
        // are opaque crypto blobs that are not tokenized as content.
        const r = part as { text?: string };
        chars += (r.text ?? '').length;
        break;
      }

      case 'file': {
        const filePart = part as any;
        fileTokens += estimateFileTokens(
          filePart.data,
          filePart.mediaType ?? 'application/octet-stream',
          charsPerToken,
        );
        break;
      }

      case 'tool-result': {
        const resultPart = part as any;
        chars += 80;
        const result = estimateToolResultOutputTokens(resultPart.output, charsPerToken);
        chars += result.chars;
        fileTokens += result.fileTokens;
        break;
      }

      case 'tool-approval-response':
        break;

      default:
        chars += JSON.stringify(part).length;
        break;
    }
  }

  return { chars, fileTokens };
}

/**
 * File-aware token estimate for a single message. Same part-walking rules as
 * estimatePromptTokensDetailed, with a per-message ceil.
 */
export function estimateMessageTokens(message: PromptMessage, model?: string): number {
  const { charsPerToken } = resolveEstimator(model);
  const { chars, fileTokens } = estimateMessageParts(message, charsPerToken);
  return Math.ceil(chars / charsPerToken) + fileTokens;
}

/**
 * File-aware prompt token estimation.
 *
 * Walks the AI SDK LanguageModelV3Prompt structure, applying JSON.stringify
 * per text/tool block and media-type heuristics for file content parts.
 * Replaces the naive "stringify everything" approach that counted raw
 * base64 data as text.
 */
export function estimatePromptTokensDetailed(
  prompt: LanguageModelV3Prompt,
  model?: string,
): TokenEstimationResult {
  const { charsPerToken, name } = resolveEstimator(model);
  let totalChars = 0;
  let totalFileTokens = 0;

  for (const message of prompt) {
    const { chars, fileTokens } = estimateMessageParts(message, charsPerToken);
    totalChars += chars;
    totalFileTokens += fileTokens;
  }

  return {
    tokens: Math.ceil(totalChars / charsPerToken) + totalFileTokens,
    estimator: name,
    charsPerToken,
  };
}

// =============================================================================
// File-aware estimation for raw provider payloads (gateway use)
// =============================================================================

const FILE_DATA_THRESHOLD = 4096;

type FileEntry = { base64Length: number; mediaType: string | undefined };

function detectMediaType(parent: Record<string, unknown>): string | undefined {
  if (typeof parent.media_type === 'string') return parent.media_type;
  if (typeof parent.mediaType === 'string') return parent.mediaType;
  if (typeof parent.mimeType === 'string') return parent.mimeType;
  return undefined;
}

function estimateFileEntryTokens(entry: FileEntry, charsPerToken: number): number {
  const bytes = Math.floor(entry.base64Length * 0.75);
  const mediaType = entry.mediaType;

  if (!mediaType) {
    return Math.ceil(bytes / 50) + 500;
  }
  if (mediaType.startsWith('image/')) return IMAGE_TOKEN_ESTIMATE;
  if (mediaType === 'application/pdf') {
    return Math.ceil(bytes / 100_000) * 2_000;
  }
  if (mediaType === 'text/plain') {
    return Math.ceil(bytes / charsPerToken);
  }
  return Math.ceil(bytes / 50) + 500;
}

/**
 * File-aware token estimation for arbitrary JSON payloads.
 *
 * Uses JSON.stringify with a replacer that detects base64 file data
 * by examining parent object context (media_type, mimeType, etc.).
 * Replaces detected file data with short placeholders and adds
 * media-type-specific token estimates.
 *
 * Designed for gateway middleware where the payload is already in
 * provider-specific format (Anthropic, OpenAI, Gemini, Bedrock).
 */
export function estimateTokensDetailedFileAware(
  payload: unknown,
  model?: string,
): TokenEstimationResult {
  const { charsPerToken, name } = resolveEstimator(model);
  const fileEntries: FileEntry[] = [];

  const stripped = JSON.stringify(
    payload,
    function replacer(this: unknown, key: string, value: unknown): unknown {
      if (typeof value !== 'string' || value.length < FILE_DATA_THRESHOLD) {
        return value;
      }

      const parent = this as Record<string, unknown>;

      if (key === 'data' && parent && typeof parent === 'object') {
        const mediaType = detectMediaType(parent);
        if (mediaType || parent.type === 'base64') {
          fileEntries.push({ base64Length: value.length, mediaType });
          return '[FILE]';
        }
      }

      if (key === 'bytes' && parent && typeof parent === 'object') {
        fileEntries.push({ base64Length: value.length, mediaType: undefined });
        return '[FILE]';
      }

      if (value.startsWith('data:') && value.length > FILE_DATA_THRESHOLD) {
        const mimeMatch = value.match(/^data:([^;,]+)/);
        const mediaType = mimeMatch?.[1];
        fileEntries.push({ base64Length: value.length, mediaType });
        return '[FILE]';
      }

      return value;
    },
  );

  const chars = stripped.length;
  let fileTokens = 0;
  for (const entry of fileEntries) {
    fileTokens += estimateFileEntryTokens(entry, charsPerToken);
  }

  return {
    tokens: Math.ceil(chars / charsPerToken) + fileTokens,
    estimator: name,
    charsPerToken,
  };
}
