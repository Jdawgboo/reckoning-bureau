/**
 * Resolves a `filesystem` `view` reference — an `https://…` URL or an `agent-storage:<path>`
 * (routed to its branch by the storage factory) — to bytes + filename + mediaType. Never
 * throws; returns a structured `LoadError` instead.
 */
import type { AgentStorage } from '../../../../vendor/agent-library/storage/agent-storage.ts';
import { sniffMimeFromName } from './file-decode.ts';

export type StorageFactoryRead = {
  getStorage(secretFolder?: string): Pick<AgentStorage, 'readFile'>;
};

export type LoadedFile = { bytes: Buffer; filename: string; mediaType: string };
export type LoadError = { error: string; filename: string };

const PER_FILE_SIZE_CAP_BYTES = 5 * 1024 * 1024;
const AGENT_STORAGE_SCHEME = 'agent-storage:';

export class FileReferenceLoader {
  readonly #storageFactory?: StorageFactoryRead;

  constructor(config?: { storageFactory?: StorageFactoryRead }) {
    this.#storageFactory = config?.storageFactory;
  }

  async load(
    reference: string,
    opts: { signal?: AbortSignal; secretFolder?: string },
  ): Promise<LoadedFile | LoadError> {
    if (reference.startsWith(AGENT_STORAGE_SCHEME)) {
      return this.#loadFromAgentStorage(reference, opts.secretFolder);
    }
    return this.#loadFromHttps(reference, opts.signal);
  }

  async #loadFromAgentStorage(
    rawUrl: string,
    secretFolder: string | undefined,
  ): Promise<LoadedFile | LoadError> {
    if (!this.#storageFactory) {
      return {
        error: 'agent-storage references require the filesystem tool to have a storage factory',
        filename: rawUrl,
      };
    }
    const path = rawUrl.slice(AGENT_STORAGE_SCHEME.length);
    if (!path) {
      return { error: 'agent-storage reference is missing the path', filename: rawUrl };
    }
    const filename = path.split('/').pop() || 'file';
    let buffer: Buffer;
    try {
      const storage = this.#storageFactory.getStorage(secretFolder);
      buffer = await storage.readFile(path);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      return { error: `storage read failed: ${msg}`, filename };
    }
    if (buffer.length > PER_FILE_SIZE_CAP_BYTES) {
      return { error: `exceeds ${PER_FILE_SIZE_CAP_BYTES / 1024 / 1024} MB cap`, filename };
    }
    return { bytes: buffer, filename, mediaType: sniffMimeFromName(filename) };
  }

  async #loadFromHttps(
    rawUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<LoadedFile | LoadError> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { error: 'invalid URL', filename: rawUrl };
    }
    if (parsed.protocol !== 'https:') {
      return {
        error: `URL must use https or agent-storage scheme (got ${parsed.protocol})`,
        filename: rawUrl,
      };
    }

    const preflight = await this.#preflightSize(parsed, signal);
    if (preflight === 'too-large') {
      return {
        error: `HEAD reports body > ${PER_FILE_SIZE_CAP_BYTES / 1024 / 1024} MB cap`,
        filename: rawUrl,
      };
    }
    if (signal?.aborted) return { error: 'canceled', filename: rawUrl };

    let response: Response;
    try {
      response = await fetch(rawUrl, { signal });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      return { error: `fetch failed: ${msg}`, filename: rawUrl };
    }
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, filename: rawUrl };
    }

    const bodyResult = await this.#readBodyWithSizeCap(response);
    if (bodyResult === 'too-large') {
      return {
        error: `body exceeded ${PER_FILE_SIZE_CAP_BYTES / 1024 / 1024} MB cap`,
        filename: rawUrl,
      };
    }
    if (bodyResult === 'empty') {
      return { error: 'empty response body', filename: rawUrl };
    }

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const filename = parsed.pathname.split('/').pop() || 'file';
    const mediaType = contentType || sniffMimeFromName(filename);
    return { bytes: bodyResult, filename, mediaType };
  }

  async #preflightSize(
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<'too-large' | 'unknown'> {
    try {
      const headResp = await fetch(url, { method: 'HEAD', signal });
      if (!headResp.ok) return 'unknown';
      const cl = headResp.headers.get('content-length');
      if (!cl) return 'unknown';
      const n = Number(cl);
      if (!Number.isFinite(n)) return 'unknown';
      return n > PER_FILE_SIZE_CAP_BYTES ? 'too-large' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async #readBodyWithSizeCap(response: Response): Promise<Buffer | 'too-large' | 'empty'> {
    const reader = response.body?.getReader();
    if (!reader) return 'empty';
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > PER_FILE_SIZE_CAP_BYTES) {
        await reader.cancel().catch(() => {});
        return 'too-large';
      }
      chunks.push(value);
    }
    if (total === 0) return 'empty';
    return Buffer.concat(chunks);
  }
}
