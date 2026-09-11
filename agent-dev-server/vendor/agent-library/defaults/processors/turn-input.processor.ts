import { FileContentEncoder, type FileEncoderConfig } from '../../files/file-content-encoder.ts';
import type { FileContentMask } from '../../files/interfaces.ts';
import { omitTextContentBySize } from '../../files/file-content-masks.ts';
import type { Attachment } from '../../core/interfaces.ts';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { TurnProcessor, TurnProcessorState } from '../../kernel/processors/types.ts';
import { getAgentLogger } from '../../types/logger.ts';

// Real MIME is baked into the data URL prefix that ImageCodec/PdfCodec build
// (e.g. `data:image/png;base64,...`). Pull it back instead of hardcoding a
// wildcard `image/*` — wildcards are malformed for Bedrock/OpenAI converters.
function extractMediaTypeFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/);
  return match?.[1] ?? 'image/jpeg';
}

type CodecFailureReason = 'unsupported' | 'parse_failed' | 'encoding_error' | 'too_large';

// Conservative default — 5 MB raw bytes per attachment. Callers can override
// via `TurnInputProcessorConfig.maxAttachmentBytes`.
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Approximate raw byte size from a base64 payload (`file.data`). Slightly
// over-counts due to `=` padding but the upper bound is safe for cap checks.
function approxRawBytes(base64: string): number {
  if (!base64) return 0;
  const stripped = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  return Math.floor((stripped.length * 3) / 4);
}

// Sanitize codec exceptions to a closed set of reasons. Never emit raw
// `error.message` into model context — exceptions can carry stack traces
// and filesystem paths that would leak through.
function classifyCodecError(error: unknown): CodecFailureReason {
  const msg = error instanceof Error ? error.message : String(error);
  if (/extension|mimetype|not supported/i.test(msg)) {
    return 'unsupported';
  }
  if (/parse|decode|invalid|malformed/i.test(msg)) {
    return 'parse_failed';
  }
  return 'encoding_error';
}

// AWS Bedrock Converse rejects `document.name` values outside the charset
// `[A-Za-z0-9 \-\(\)\[\]]`. The AI SDK Bedrock adapter passes the
// `filename` field through verbatim, so we sanitize at the source. Other
// providers accept the cleaned name harmlessly — they only use it to refer
// the model back to the file in conversation.
function sanitizeFilenameForBedrock(filename: string): string {
  const stripped = filename.replace(/\.[^./\\]+$/, '');
  const cleaned = stripped.replace(/[^A-Za-z0-9 \-()[\]]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'document';
}

// Sanitize a filename for inclusion in text content that the model will
// see (e.g. synthetic-error markers, `File name: X` inlines). The threat
// model is prompt injection through a crafted filename — strip control
// characters, newlines, and bracket characters that could spoof system
// markers. Length-cap to 100 chars to keep things bounded.
function sanitizeFilenameForModelText(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — we want to strip them
  const cleaned = filename.replace(/[[\]\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
  const truncated = cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
  return truncated || 'file';
}

/**
 * Configuration for TurnInputProcessor
 */
export interface TurnInputProcessorConfig {
  /**
   * File encoder configuration - enable/disable specific file types.
   * @default All encoders enabled
   */
  fileEncoders?: FileEncoderConfig;

  /**
   * File content masks to apply before encoding.
   * @default [omitTextContentBySize(10MB)]
   */
  fileMasks?: FileContentMask[];

  /**
   * Disable file encoding entirely.
   * When true, attachments are ignored.
   * @default false
   */
  disableFileEncoding?: boolean;

  /**
   * Maximum raw bytes per attachment. Files larger than this are skipped
   * with a synthetic `too_large` error part in the user turn — never
   * processed by a codec. This is the server-side safety net independent
   * of any client-side limit.
   * @default 5 * 1024 * 1024 (5 MB)
   */
  maxAttachmentBytes?: number;
}

/**
 * TurnInputProcessor
 *
 * Conceptually different from model middlewares:
 * - runs once per agent turn (not per model call/step)
 * - can intentionally COMMIT messages into canonical conversation history
 *
 * This is the right place for "current user instruction + attachments" injection.
 *
 * @example
 * ```typescript
 * // Default - all file encoders enabled
 * const processor = new TurnInputProcessor();
 *
 * // Only enable image and text encoding
 * const processor = new TurnInputProcessor({
 *   fileEncoders: { image: true, text: true, pdf: false, word: false, excel: false }
 * });
 *
 * // Disable file encoding entirely
 * const processor = new TurnInputProcessor({ disableFileEncoding: true });
 *
 * // Custom file size limit
 * const processor = new TurnInputProcessor({
 *   fileMasks: [omitTextContentBySize(1024 * 1024)] // 1MB limit
 * });
 * ```
 */
export class TurnInputProcessor implements TurnProcessor {
  private readonly fileContentEncoder: FileContentEncoder | null;
  private readonly fileContentMasks: FileContentMask[];
  private readonly maxAttachmentBytes: number;

  constructor(config: TurnInputProcessorConfig = {}) {
    if (config.disableFileEncoding) {
      this.fileContentEncoder = null;
    } else {
      this.fileContentEncoder = new FileContentEncoder(config.fileEncoders);
    }
    this.fileContentMasks = config.fileMasks ?? [omitTextContentBySize(1024 * 1024 * 10)];
    this.maxAttachmentBytes = config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  async buildUserTurnMessage(args: {
    instruction: string;
    attachments: Attachment[];
  }): Promise<ModelMessage> {
    const { instruction, attachments } = args;

    const userParts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; data: string; mediaType: string; filename?: string }
    > = [];

    if (instruction) {
      userParts.push({ type: 'text', text: instruction });
    }

    const logger = getAgentLogger();

    // Only process attachments if file encoding is enabled
    if (this.fileContentEncoder && attachments.length > 0) {
      for (const file of attachments) {
        // Server-side size guard — independent of any client-side check.
        // We approximate from base64 length to avoid decoding before we know
        // the file is small enough to be worth decoding.
        const rawBytes = approxRawBytes(file.data ?? '');
        if (rawBytes > this.maxAttachmentBytes) {
          userParts.push({
            type: 'text',
            text: `[Attached file ${sanitizeFilenameForModelText(file.name)} could not be processed: too_large]`,
          });
          logger.warn('[attachment.processed]', {
            filename: file.name,
            mediaType: file.type,
            rawBytes,
            durationMs: 0,
            status: 'failure',
            reason: 'too_large',
          });
          continue;
        }

        const maskedFile = this.fileContentMasks.reduce(
          (resultFile, mask) => mask(resultFile),
          file,
        );

        const t0 = Date.now();
        try {
          const encodedFile = await this.fileContentEncoder.encode(maskedFile);
          const encoded = encodedFile.llmEncoded || [];

          encoded.forEach(({ contentType, data }) => {
            if (['text', 'json'].includes(contentType)) {
              userParts.push({
                type: 'text',
                text: `File name: ${sanitizeFilenameForModelText(file.name)}\nFile content: ${data}`,
              });
            } else if (contentType === 'base64_image') {
              userParts.push({
                type: 'file',
                mediaType: extractMediaTypeFromDataUrl(data),
                data,
                filename: sanitizeFilenameForBedrock(file.name),
              });
            } else if (contentType === 'base64_pdf') {
              userParts.push({
                type: 'file',
                mediaType: 'application/pdf',
                data,
                filename: sanitizeFilenameForBedrock(file.name),
              });
            }
          });

          logger.info('[attachment.processed]', {
            filename: file.name,
            mediaType: file.type,
            rawBytes: file.data?.length ?? 0,
            contentTypeProduced: encoded.map((p) => p.contentType),
            durationMs: Date.now() - t0,
            status: 'success',
          });
        } catch (error) {
          // Replace the previous silent drop with a synthetic text part so
          // the model can acknowledge to the user that the file did not
          // reach context, instead of pretending it processed something.
          const reason = classifyCodecError(error);
          userParts.push({
            type: 'text',
            text: `[Attached file ${sanitizeFilenameForModelText(file.name)} could not be processed: ${reason}]`,
          });
          logger.warn('[attachment.processed]', {
            filename: file.name,
            mediaType: file.type,
            rawBytes: file.data?.length ?? 0,
            durationMs: Date.now() - t0,
            status: 'failure',
            reason,
          });
        }
      }
    }

    return {
      role: 'user',
      content: userParts.length ? (userParts as any) : [{ type: 'text', text: '' }],
    } as any;
  }

  /**
   * Applies the processor to AgentState:
   * - appends the turn input as a user message into canonical conversation history
   * - marks injected for idempotency during multi-step runs
   */
  async process(state: TurnProcessorState): Promise<ModelMessage[] | null> {
    if (state.hasTurnInputInjected()) {
      return null;
    }

    const instruction = state.getUserQueryText() ?? '';
    const attachments = state.getAttachments();

    // Nothing to inject — e.g. blocking tool resume where the user's
    // response is already in the rewritten tool-result history.
    if (!instruction && attachments.length === 0) {
      state.markTurnInputInjected();
      return null;
    }

    const currentHistory = state.getConversationHistory();

    state.markTurnInputInjected();
    const userMessage = await this.buildUserTurnMessage({ instruction, attachments });
    return [...currentHistory, userMessage];
  }
}
