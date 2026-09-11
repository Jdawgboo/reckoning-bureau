import sharp from 'sharp';
import { FileContentEncoder, type Attachment } from '../../agent/agent-library.ts';

const IMAGE_LONG_SIDE_PX = 1600;
const IMAGE_JPEG_QUALITY = 80;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/;
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|xlsx?)$/;

export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const HEIC_HINT = 'HEIC/HEIF not supported — convert to PNG or JPEG first';
export const PPTX_HINT =
  '.pptx not supported — convert via the code-executor subagent (`soffice --convert-to pdf`) then view the resulting PDF';
export const HTML_HINT = 'URL returns an HTML page — use the page-fetcher subagent for web pages';

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: PPTX_MIME,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
};

export function sniffMimeFromName(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_TO_MIME[ext] ?? '';
}

export type ViewFileKind = 'image' | 'document' | 'text' | 'pptx' | 'heic' | 'html';

export function classifyFileForView(filename: string, mediaType: string): ViewFileKind {
  const lower = filename.toLowerCase();

  if (mediaType === PPTX_MIME || lower.endsWith('.pptx')) {
    return 'pptx';
  }
  if (
    mediaType === 'image/heic' ||
    mediaType === 'image/heif' ||
    lower.endsWith('.heic') ||
    lower.endsWith('.heif')
  ) {
    return 'heic';
  }
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    return 'html';
  }
  if (mediaType.startsWith('image/') || IMAGE_EXTENSIONS.test(lower)) {
    return 'image';
  }
  if (DOCUMENT_MIMES.has(mediaType) || DOCUMENT_EXTENSIONS.test(lower)) {
    return 'document';
  }
  return 'text';
}

export async function resizeImageToJpeg(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes)
    .resize({
      width: IMAGE_LONG_SIDE_PX,
      height: IMAGE_LONG_SIDE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: IMAGE_JPEG_QUALITY })
    .toBuffer();
}

// pdfMode: 'text' — Bedrock tool_result rejects native PDF binary.
const documentEncoder = new FileContentEncoder({ pdfMode: 'text' });

export async function extractDocumentText(
  bytes: Buffer,
  filename: string,
  mediaType: string,
): Promise<string> {
  const attachment: Attachment = {
    name: filename,
    type: mediaType || 'application/octet-stream',
    data: `data:${mediaType || 'application/octet-stream'};base64,${bytes.toString('base64')}`,
    updateTms: Date.now(),
  };

  const encoded = await documentEncoder.encode(attachment);
  const parts: string[] = [];
  for (const piece of encoded.llmEncoded) {
    if (piece.contentType === 'text' || piece.contentType === 'json') {
      parts.push(typeof piece.data === 'string' ? piece.data : String(piece.data));
    } else {
      throw new Error(`unexpected encoder output for ${filename}: ${piece.contentType}`);
    }
  }
  return parts.join('\n');
}
