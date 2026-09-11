import type { Attachment } from '@/app/lib/types/files';

export const COMPOSER_ACCEPT_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.docx',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
] as const;

export const COMPOSER_ACCEPT_ATTR = COMPOSER_ACCEPT_EXTENSIONS.join(',');

export const COMPOSER_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const COMPOSER_MAX_FILES = 5;

export type AttachError =
  | { code: 'too_large'; filename: string; size: number }
  | { code: 'unsupported'; filename: string; extension: string }
  | { code: 'too_many'; allowed: number };

export type AttachResult = { attachments: Attachment[]; errors: AttachError[] };

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

export function mimeFromExtension(ext: string): string {
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * Convert browser `File[]` into wire-format `Attachment[]`, enforcing the
 * composer's whitelist + size + count limits. Errors are returned separately
 * from the accepted attachments so the UI can surface them inline.
 */
export async function filesToAttachments(
  incoming: File[],
  existing: Attachment[],
): Promise<AttachResult> {
  const errors: AttachError[] = [];
  const acceptList = new Set<string>(COMPOSER_ACCEPT_EXTENSIONS);
  const accepted: File[] = [];

  for (const f of incoming) {
    const ext = getExtension(f.name);
    if (!acceptList.has(ext)) {
      errors.push({ code: 'unsupported', filename: f.name, extension: ext || '(none)' });
      continue;
    }
    if (f.size > COMPOSER_MAX_FILE_BYTES) {
      errors.push({ code: 'too_large', filename: f.name, size: f.size });
      continue;
    }
    accepted.push(f);
  }

  const room = COMPOSER_MAX_FILES - existing.length;
  if (accepted.length > room) {
    errors.push({ code: 'too_many', allowed: COMPOSER_MAX_FILES });
    accepted.length = Math.max(0, room);
  }

  const attachments: Attachment[] = [];
  for (const f of accepted) {
    const data = await readAsBase64(f);
    attachments.push({
      name: f.name,
      type: f.type || mimeFromExtension(getExtension(f.name)),
      data,
      updateTms: Date.now(),
    });
  }
  return { attachments, errors };
}
