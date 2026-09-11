import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';
import { AbstractStorageAdapter, type AdapterWriteOptions } from './abstract-storage-adapter.ts';
import type { RawFileMetadata, SearchOptions, SearchResult, SearchFileResult } from '../types.ts';
import { StorageApiError, StorageFileNotFoundError } from '../types.ts';
import { textSearch, SEARCH_MAX_BYTES, SEARCH_MAX_FILES } from '../search-utils.ts';

const SEARCHABLE_TYPE_RE = /^(text\/|application\/(json|xml|javascript|typescript))/;

const compressAsync = promisify(zstdCompress);
const decompressAsync = promisify(zstdDecompress);

export type AgentPlaceApiAdapterParams = {
  /** Server URL (required) - e.g., 'https://api.agentplace.io' */
  apiBaseUrl: string;
  /** Auth key for API (required) */
  accessKey: string;
  /** Secret folder for private storage isolation (optional) */
  secretFolder?: string;
  /** Enable zstd compression for uploads/downloads (default: false) */
  compression?: boolean;
  /**
   * Namespace every operation under this filename prefix (e.g. 'tool-results/').
   * Lets two adapters share one location: this adapter only sees files under the
   * prefix and exposes them with the prefix stripped.
   */
  filePrefix?: string;
  /** Drop listed entries under these prefixes (the complement of filePrefix). */
  excludePrefixes?: string[];
};

/**
 * Storage adapter for AgentPlace API (remote HTTP storage).
 *
 * - writable: true
 * - cacheableList: true (network calls are expensive)
 * - cacheableContent: true (network calls are expensive)
 */
export class AgentPlaceApiAdapter extends AbstractStorageAdapter {
  #apiBaseUrl: string;
  #accessKey: string;
  #secretFolder?: string;
  #compression: boolean;
  #filePrefix: string;
  #excludePrefixes: string[];

  constructor(params: AgentPlaceApiAdapterParams) {
    super();
    this.#apiBaseUrl = params.apiBaseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.#accessKey = params.accessKey;
    this.#secretFolder = params.secretFolder;
    this.#compression = params.compression ?? false;
    this.#filePrefix = params.filePrefix ?? '';
    this.#excludePrefixes = params.excludePrefixes ?? [];
  }

  // ============================================================================
  // Adapter Properties
  // ============================================================================

  get writable(): boolean {
    return true;
  }

  get cacheableList(): boolean {
    return true;
  }

  get cacheableContent(): boolean {
    return true;
  }

  override get searchable(): boolean {
    return true;
  }

  // ============================================================================
  // Search
  // ============================================================================

  /**
   * In-process search: list + read + textSearch, bounded by SEARCH_MAX_FILES /
   * SEARCH_MAX_BYTES so a pathological branch cannot stall a grep.
   */
  override async search(
    pattern: string,
    options?: SearchOptions,
  ): Promise<SearchResult[] | SearchFileResult[]> {
    const all = await this.listFiles();
    const files = new Map<string, string>();
    let bytes = 0;
    let scanned = 0;
    for (const meta of all) {
      if (options?.path && !meta.path.startsWith(options.path)) {
        continue;
      }
      if (meta.contentType && !SEARCHABLE_TYPE_RE.test(meta.contentType)) {
        continue;
      }
      if (scanned >= SEARCH_MAX_FILES || bytes + meta.size > SEARCH_MAX_BYTES) {
        this.logger?.debug(
          'storage:adapter:api',
          `[${this.adapterName}] search budget reached (${scanned} files, ${bytes} bytes) — remaining skipped`,
        );
        break;
      }
      const content = await this.readFile(meta.path);
      if (content === null) {
        continue;
      }
      scanned += 1;
      bytes += content.length;
      files.set(meta.path, content.toString('utf-8'));
    }
    return textSearch(files, pattern, options);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  #getHeaders(): Record<string, string> {
    return {
      'x-access-key': this.#accessKey,
    };
  }

  #toRemote(filePath: string): string {
    return `${this.#filePrefix}${filePath}`;
  }

  // ============================================================================
  // Storage Operations
  // ============================================================================

  async readFile(filePath: string): Promise<Buffer | null> {
    const startTime = performance.now();
    const params = new URLSearchParams({ path: this.#toRemote(filePath) });
    if (this.#secretFolder) {
      params.set('location', this.#secretFolder);
    }

    const endpoint = `/storage/download?${params.toString()}`;
    this.logger?.debug('storage:adapter:api', `[${this.adapterName}] GET ${endpoint}`);

    const downloadStart = performance.now();
    const response = await fetch(`${this.#apiBaseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.#getHeaders(),
    });
    const downloadTime = Math.round(performance.now() - downloadStart);

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Response: ${response.status} ${response.statusText} (${downloadTime}ms)`,
    );

    if (response.status === 404) {
      this.logger?.debug(
        'storage:adapter:api',
        `[${this.adapterName}] File not found: '${filePath}'`,
      );
      return null; // File not found
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.logger?.error(
        'storage:adapter:api',
        `[${this.adapterName}] Request failed: ${response.status}`,
        errorText,
      );
      throw new StorageApiError(response.status, errorText, endpoint);
    }

    const arrayBuffer = await response.arrayBuffer();
    let content = Buffer.from(arrayBuffer);

    // Check for custom compression header (X-File-Compression instead of Content-Encoding)
    // We use X-File-Compression to avoid HTTP stack auto-decompression
    const fileCompression = response.headers.get('x-file-compression');
    const originalSize = response.headers.get('x-original-size');

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Downloaded: '${filePath}' (${content.length} bytes, ${downloadTime}ms)`,
      {
        compressed: fileCompression === 'zstd',
        originalSize,
      },
    );

    if (fileCompression === 'zstd') {
      this.logger?.debug(
        'storage:adapter:api',
        `[${this.adapterName}] Decompressing zstd data (${content.length} bytes)...`,
      );
      const decompressStart = performance.now();
      try {
        const decompressed = await decompressAsync(content);
        const decompressTime = Math.round(performance.now() - decompressStart);
        this.logger?.debug(
          'storage:adapter:api',
          `[${this.adapterName}] Decompressed: ${content.length} → ${decompressed.length} bytes (${decompressTime}ms)`,
        );
        content = decompressed as Buffer<ArrayBuffer>;
      } catch (error) {
        this.logger?.error(
          'storage:adapter:api',
          `[${this.adapterName}] Decompression failed`,
          error,
        );
        throw error;
      }
    }

    const totalTime = Math.round(performance.now() - startTime);
    this.logger?.info(
      'storage:adapter:api',
      `[${this.adapterName}] Read successful: '${filePath}' (${content.length} bytes, ${totalTime}ms)`,
    );
    return content;
  }

  async writeFile(
    filePath: string,
    content: Buffer,
    contentType: string,
    options?: AdapterWriteOptions,
  ): Promise<void> {
    const startTime = performance.now();
    const params = new URLSearchParams({ path: this.#toRemote(filePath) });
    if (this.#secretFolder) {
      params.set('location', this.#secretFolder);
    }

    const endpoint = `/storage/upload?${params.toString()}`;

    // Prepare content and headers
    let uploadContent: Buffer = content;
    const originalSize = content.length;
    const headers: Record<string, string> = this.#getHeaders();

    // Determine compression: per-file option overrides adapter default
    const shouldCompress = options?.compression ?? this.#compression;

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Writing file: '${filePath}' (${originalSize} bytes, ${contentType})`,
      { compression: shouldCompress },
    );

    // Compress if enabled
    // Note: We use X-File-Compression instead of Content-Encoding because:
    // 1. Content-Encoding describes the HTTP body encoding, not the file content
    // 2. Proxies may auto-decompress Content-Encoding, corrupting multipart form-data
    let compressTime = 0;
    if (shouldCompress) {
      const compressStart = performance.now();
      uploadContent = await compressAsync(content);
      compressTime = Math.round(performance.now() - compressStart);
      headers['x-file-compression'] = 'zstd';
      headers['x-original-size'] = originalSize.toString();
      this.logger?.debug(
        'storage:adapter:api',
        `[${this.adapterName}] Compressed: ${originalSize} → ${uploadContent.length} bytes (${compressTime}ms)`,
      );
    }

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(uploadContent)], { type: contentType });
    formData.append('file', blob, filePath.split('/').pop() || 'file');

    this.logger?.debug('storage:adapter:api', `[${this.adapterName}] POST ${endpoint}`);

    const uploadStart = performance.now();
    const response = await fetch(`${this.#apiBaseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const uploadTime = Math.round(performance.now() - uploadStart);

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Response: ${response.status} ${response.statusText} (${uploadTime}ms)`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      this.logger?.error(
        'storage:adapter:api',
        `[${this.adapterName}] Upload failed: ${response.status}`,
        errorText,
      );
      throw new StorageApiError(response.status, errorText, endpoint);
    }

    const totalTime = Math.round(performance.now() - startTime);
    this.logger?.info(
      'storage:adapter:api',
      `[${this.adapterName}] Write successful: '${filePath}' (${originalSize} bytes, ${totalTime}ms)`,
    );
  }

  async deleteFile(filePath: string): Promise<void> {
    const params = new URLSearchParams({ path: this.#toRemote(filePath) });
    if (this.#secretFolder) {
      params.set('location', this.#secretFolder);
    }

    const endpoint = `/storage/delete?${params.toString()}`;

    this.logger?.debug('storage:adapter:api', `[${this.adapterName}] Deleting file: '${filePath}'`);
    this.logger?.debug('storage:adapter:api', `[${this.adapterName}] DELETE ${endpoint}`);

    const response = await fetch(`${this.#apiBaseUrl}${endpoint}`, {
      method: 'DELETE',
      headers: this.#getHeaders(),
    });

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Response: ${response.status} ${response.statusText}`,
    );

    if (response.status === 404) {
      this.logger?.error(
        'storage:adapter:api',
        `[${this.adapterName}] Delete failed: '${filePath}' not found`,
      );
      throw new StorageFileNotFoundError(filePath, []);
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.logger?.error(
        'storage:adapter:api',
        `[${this.adapterName}] Delete failed: ${response.status}`,
        errorText,
      );
      throw new StorageApiError(response.status, errorText, endpoint);
    }

    this.logger?.info(
      'storage:adapter:api',
      `[${this.adapterName}] Delete successful: '${filePath}'`,
    );
  }

  async listFiles(): Promise<RawFileMetadata[]> {
    const startTime = performance.now();
    const endpoint = this.#secretFolder
      ? `/storage/list/${encodeURIComponent(this.#secretFolder)}`
      : '/storage/list';

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Listing files from: ${this.#secretFolder || 'root'}`,
    );
    this.logger?.debug('storage:adapter:api', `[${this.adapterName}] GET ${endpoint}`);

    const response = await fetch(`${this.#apiBaseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.#getHeaders(),
    });
    const requestTime = Math.round(performance.now() - startTime);

    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Response: ${response.status} ${response.statusText} (${requestTime}ms)`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      this.logger?.error(
        'storage:adapter:api',
        `[${this.adapterName}] List failed: ${response.status}`,
        errorText,
      );
      throw new StorageApiError(response.status, errorText, endpoint);
    }

    const data = (await response.json()) as {
      success: boolean;
      files: Array<{
        filename: string;
        size: number;
        contentType: string;
        uploadedAt?: string;
        isCompressed?: boolean;
        originalSize?: number;
      }>;
    };

    const files = data.files
      .filter((f) => !this.#filePrefix || f.filename.startsWith(this.#filePrefix))
      .filter((f) => !this.#excludePrefixes.some((prefix) => f.filename.startsWith(prefix)))
      .map((f) => ({
        path: f.filename.slice(this.#filePrefix.length), // API returns 'filename', we normalize to 'path'
        size: f.size,
        contentType: f.contentType,
        uploadedAt: f.uploadedAt,
        isCompressed: f.isCompressed,
        originalSize: f.originalSize,
      }));

    const totalTime = Math.round(performance.now() - startTime);
    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] List complete: ${files.length} files (${totalTime}ms)`,
    );
    return files;
  }

  async exists(filePath: string): Promise<boolean> {
    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Checking existence: '${filePath}'`,
    );
    const content = await this.readFile(filePath);
    const exists = content !== null;
    this.logger?.debug(
      'storage:adapter:api',
      `[${this.adapterName}] Exists check: '${filePath}' = ${exists}`,
    );
    return exists;
  }
}
