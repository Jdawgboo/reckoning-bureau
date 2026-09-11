import type { Attachment } from '../core/interfaces.ts';

export type AttachmentExtended = Attachment & {
  /**
   * Encoded content compatible with LLM
   */
  llmEncoded: FileEncodedContent[];
};

/**
 * Binary image content encoded in base64 format.
 */
export type Base64EncodedImage = {
  contentType: 'base64_image';
  data: string;
};

/**
 * Binary PDF content encoded in base64 format.
 *
 * Emitted as a native multimodal file part for providers with PDF support
 * (Anthropic / Bedrock / Gemini). Avoids the layout/table/figure loss that
 * comes from pdf-parse text extraction.
 */
export type Base64EncodedPdf = {
  contentType: 'base64_pdf';
  data: string;
};

/**
 * Text content
 */
export type EncodedText = {
  contentType: 'text' | 'json';
  data: string;
};

/**
 * File encoded content type
 */
export type FileEncodedContent = Base64EncodedImage | Base64EncodedPdf | EncodedText;

/**
 * Interface for file encoding strategies.
 * Provides a method to encode an attachment into a specific content format compatible with LLM.
 */
export interface FileCodecI {
  /**
   * Encodes the provided file attachment content to a typically
   * {@link FileEncodedContent more "primitive"} format suitable for processing by LLMs.
   *
   * @param file The file attachment to encode.
   * @returns A promise that resolves to the encoded file content.
   */
  encode(file: Attachment): Promise<FileEncodedContent[]>;
}

/**
 * A function type that takes an `Attachment` and returns a masked version of it.
 * This can be used to remove or obfuscate information from the file content.
 */
export type FileContentMask = (file: Attachment) => Attachment;
