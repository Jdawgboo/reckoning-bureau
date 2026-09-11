/**
 * Channel-agnostic attachment downloader. Universal — works in Node and the browser.
 *
 * Native-SDK channels (Telegram via telegraf, Discord via discord.js) each
 * expose their own file-attachment shapes. This module converts both into
 * the agent-library's canonical `Attachment` shape that `TurnInputProcessor`
 * + `FileContentEncoder` already know how to feed to the LLM (images →
 * multimodal file parts, PDFs/Word/Excel → text via extractors, plain
 * text → inline).
 *
 * Two layers:
 * - Per-channel extractors (e.g. `extractTelegramAttachments`,
 *   `extractDiscordAttachments`) produce `IncomingAttachmentRef[]` — URL + metadata.
 * - This downloader fetches bytes, base64-encodes, and enforces size/type
 *   policy uniformly.
 */

/**
 * Minimal `Attachment` shape — kept local to avoid importing
 * `core/interfaces.ts` (which pulls in AI SDK types and is server-only).
 * Structurally identical to the canonical `Attachment` exported from
 * agent-library/index, so server consumers can use the values returned here
 * wherever the canonical type is expected.
 */
export interface Attachment {
  type: string;
  name: string;
  data: string;
  updateTms: number;
  description?: string;
  url?: string;
}

/**
 * Normalized attachment reference — what a per-channel extractor produces.
 *
 * `url` must be fetchable with a plain `fetch(url)` — authentication, if
 * any, is embedded in the URL by the channel (Telegram's `getFileLink`
 * URLs embed the bot token; Discord CDN URLs need no auth).
 */
export interface IncomingAttachmentRef {
  url: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
  description?: string;
}

export interface DownloadOptions {
  /** Max size per file in bytes. Default 10 MB. */
  maxBytesPerFile?: number;
  /** Max number of files per message. Default 5. */
  maxFiles?: number;
  /** Allow predicate. Default: images, PDFs, text/json, common office docs. */
  allowType?: (contentType: string | undefined) => boolean;
  /** Per-fetch timeout in ms. Default 15s. Pass 0 to disable. */
  timeoutMs?: number;
  /** Fetch impl override for testing. */
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  files: Attachment[];
  rejected: Array<{ name: string; reason: string }>;
}

/** Default MIME allow-list — matches what the agent-library's FileContentEncoder handles. */
export function defaultAllowType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) {
    return true;
  }
  if (ct.startsWith('text/')) {
    return true;
  }
  if (ct === 'application/json') {
    return true;
  }
  if (ct === 'application/pdf') {
    return true;
  }
  if (ct === 'application/msword') {
    return true;
  }
  if (ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return true;
  }
  if (ct === 'application/vnd.ms-excel') {
    return true;
  }
  if (ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return true;
  }
  return false;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Download attachment refs and convert into agent-library `Attachment` objects.
 * Enforces size/type policy. Returns accepted `files` and `rejected` items
 * with human-readable reasons.
 */
export async function downloadAttachments(
  refs: IncomingAttachmentRef[],
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const allow = opts.allowType ?? defaultAllowType;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const files: Attachment[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  const capped = refs.slice(0, maxFiles);
  for (const dropped of refs.slice(maxFiles)) {
    rejected.push({ name: dropped.name, reason: `over max-files cap (${maxFiles})` });
  }

  for (const ref of capped) {
    if (!allow(ref.contentType)) {
      rejected.push({
        name: ref.name,
        reason: `unsupported type (${ref.contentType ?? 'unknown'})`,
      });
      continue;
    }
    if (typeof ref.sizeBytes === 'number' && ref.sizeBytes > maxBytes) {
      rejected.push({ name: ref.name, reason: `too large (${ref.sizeBytes} > ${maxBytes} bytes)` });
      continue;
    }

    try {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const resp = await fetchImpl(ref.url, signal ? { signal } : undefined);
      if (!resp.ok) {
        rejected.push({ name: ref.name, reason: `fetch failed HTTP ${resp.status}` });
        continue;
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        rejected.push({
          name: ref.name,
          reason: `too large (${bytes.byteLength} > ${maxBytes} bytes)`,
        });
        continue;
      }
      const mime =
        ref.contentType ?? resp.headers.get('content-type') ?? 'application/octet-stream';
      files.push({
        type: mime,
        name: ref.name || 'file',
        data: bytesToBase64(bytes),
        updateTms: Date.now(),
        ...(ref.description ? { description: ref.description } : {}),
      });
    } catch (err) {
      rejected.push({
        name: ref.name,
        reason: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { files, rejected };
}

/**
 * Universal base64 encoder. Prefers Node's `Buffer` when available (faster
 * for large blobs, avoids the call-stack limit on `String.fromCharCode.apply`),
 * falls back to chunked `btoa` in the browser.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Node path (fast)
  const B = (
    globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } } }
  ).Buffer;
  if (B) {
    return B.from(bytes).toString('base64');
  }
  // Browser path — chunk to avoid call-stack overflow on large inputs
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

/** Build a short, user-facing explanation of what was skipped. */
export function formatRejectedSummary(rejected: DownloadResult['rejected']): string | null {
  if (rejected.length === 0) {
    return null;
  }
  const lines = rejected.slice(0, 5).map((r) => `• ${r.name} — ${r.reason}`);
  if (rejected.length > 5) {
    lines.push(`… and ${rejected.length - 5} more`);
  }
  return `Skipped ${rejected.length} file(s):\n${lines.join('\n')}`;
}
