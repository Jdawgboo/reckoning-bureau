import { PDFParse } from 'pdf-parse';
import type { Base64EncodedPdf, EncodedText, FileCodecI } from '../interfaces.ts';
import type { Attachment } from '../../core/interfaces.ts';
import { removeBase64Prefix } from './utils.ts';

/**
 * PDF codec. `native` (default) emits `base64_pdf` — model reads layout,
 * tables, figures (user-attachment path). `text` emits extracted text via
 * `pdf-parse` (lossy) — for tool-result paths on providers that reject
 * `file-data` in tool_result (e.g. Bedrock Converse).
 */
export type PdfCodecMode = 'native' | 'text';

const SCANNED_PDF_MARKER =
  '[PDF contains no extractable text — likely a scanned document without OCR. ' +
  'Ask the user to attach the PDF directly for layout-aware reading.]';

export class PdfCodec implements FileCodecI {
  readonly #mode: PdfCodecMode;

  constructor(opts: { mode?: PdfCodecMode } = {}) {
    this.#mode = opts.mode ?? 'native';
  }

  async encode(file: Attachment): Promise<(Base64EncodedPdf | EncodedText)[]> {
    if (this.#mode === 'text') {
      return this.#encodeAsText(file);
    }
    return this.#encodeAsNative(file);
  }

  async #encodeAsNative(file: Attachment): Promise<Base64EncodedPdf[]> {
    const base64 = removeBase64Prefix(file.data);
    return [
      {
        contentType: 'base64_pdf',
        data: `data:application/pdf;base64,${base64}`,
      },
    ];
  }

  async #encodeAsText(file: Attachment): Promise<EncodedText[]> {
    const base64 = removeBase64Prefix(file.data);
    const buffer = Buffer.from(base64, 'base64');
    const parser = new PDFParse({ data: buffer });
    const { text } = await parser.getText();
    // pdf-parse emits `-- N of M --` separators even for empty pages — strip
    // them before testing for the scanned-PDF case. Whitespace-tolerant in
    // case the separator format changes in a future pdf-parse release.
    const stripped = text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '').trim();
    if (stripped === '') {
      return [{ contentType: 'text', data: SCANNED_PDF_MARKER }];
    }
    return [{ contentType: 'text', data: text }];
  }
}
