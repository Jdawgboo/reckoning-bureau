import type { AbstractStorageAdapter } from './adapters/abstract-storage-adapter.ts';
import type { StorageLogger } from './storage-logger.ts';

// ============================================================================
// Named Adapter
// ============================================================================

/** A named adapter for use in AgentStorage */
export type NamedAdapter = {
  /** Unique name for this adapter (used for explicit read/write targeting) */
  name: string;
  /** The adapter instance */
  adapter: AbstractStorageAdapter;
};

// ============================================================================
// Configuration
// ============================================================================

export type AgentStorageParams = {
  /** Array of named adapters in resolution order (first = highest priority) */
  adapters: NamedAdapter[];

  /** Enable caching (default: true) */
  cacheEnabled?: boolean;

  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtl?: number;

  /** Enable debug logging (default: false) */
  debugEnabled?: boolean;

  /** Optional namespace filter for debug logging (e.g., ['storage:read', 'storage:cache']) */
  debugNamespaces?: string[];

  /** Custom logger implementation (defaults to console) */
  logger?: StorageLogger;

  /** Route operations by path prefix. Longest prefix wins. Prefix stripped before passing to adapter. */
  pathRouting?: PathRoutingConfig;

  /**
   * Adapter name used for paths that match no `pathRouting` prefix.
   * Lets a consumer declare its "bare paths go here" policy (e.g. the builder
   * routes unprefixed paths to `source`) instead of baking that default into
   * tools. When unset, unprefixed reads fall through the resolution chain and
   * unprefixed writes go to the first writable adapter (legacy behavior).
   */
  defaultAdapter?: string;
};

// ============================================================================
// Read/Write Options & Results
// ============================================================================

export type StorageReadOptions = {
  /** Explicit adapter name to read from (skips chain resolution) */
  adapter?: string;
  /** Line offset for partial reads (0-based). Negative values count from end. */
  offset?: number;
  /** Maximum number of lines to return */
  limit?: number;
};

export type StorageWriteOptions = {
  /** Explicit adapter name to write to (default: first writable adapter) */
  adapter?: string;
  /** Enable zstd compression for this file (overrides adapter default) */
  compression?: boolean;
};

export type StorageWriteResult = {
  path: string;
  /** Name of the adapter that was written to */
  adapter: string;
};

// ============================================================================
// Search Types
// ============================================================================

export interface SearchOptions {
  /** Scope search to paths matching this prefix or glob */
  path?: string;
  /** File glob filter (grep --include) */
  include?: string;
  /** Lines of context around each match (grep -C) */
  context?: number;
  /** Case-insensitive search (grep -i) */
  ignoreCase?: boolean;
  /** Maximum number of results to return */
  maxResults?: number;
  /** Return only file paths, not content (grep -l) */
  filesOnly?: boolean;
}

export interface SearchResult {
  /** File path (relative to adapter root) */
  file: string;
  /** 1-based line number of the match */
  line: number;
  /** Content of the matching line */
  content: string;
  /** Surrounding context lines, if requested */
  context?: { before: string[]; after: string[] };
}

export interface SearchFileResult {
  /** File path (relative to adapter root) */
  file: string;
}

/** Path prefix → adapter name mapping for deterministic routing */
export type PathRoutingConfig = Record<string, string>;

// ============================================================================
// File Metadata
// ============================================================================

/** Metadata for a file from a specific adapter */
export type AdapterFileMetadata = {
  /** Adapter name */
  adapter: string;
  size: number;
  contentType: string;
  uploadedAt?: string;
  /** Whether the file is stored compressed */
  isCompressed?: boolean;
  /** Original size before compression (only set if isCompressed) */
  originalSize?: number;
};

export type StorageFileMetadata = {
  path: string;
  /** Primary adapter (first in resolution chain where file exists) */
  adapter: string;
  size: number;
  contentType: string;
  uploadedAt?: string;
  /** Whether the file is stored compressed */
  isCompressed?: boolean;
  /** Original size before compression (only set if isCompressed) */
  originalSize?: number;
  /** Additional adapters where this file also exists */
  additionalAdapters?: AdapterFileMetadata[];
};

/** Internal: raw file metadata from a single adapter */
export type RawFileMetadata = {
  path: string;
  size: number;
  contentType: string;
  uploadedAt?: string;
  /** Whether the file is stored compressed */
  isCompressed?: boolean;
  /** Original size before compression (only set if isCompressed) */
  originalSize?: number;
};

// ============================================================================
// Error Classes
// ============================================================================

/** Base error for all storage errors */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** File not found in any searched adapter */
export class StorageFileNotFoundError extends StorageError {
  path: string;
  searchedAdapters: string[];

  constructor(path: string, searchedAdapters: string[]) {
    const searched = searchedAdapters.length > 0 ? searchedAdapters.join(', ') : 'none';
    super(`File not found: "${path}" (searched adapters: ${searched})`);
    this.name = 'StorageFileNotFoundError';
    this.path = path;
    this.searchedAdapters = searchedAdapters;
  }
}

/** Requested adapter is not configured */
export class StorageAdapterNotFoundError extends StorageError {
  adapterName: string;

  constructor(adapterName: string) {
    super(`Storage adapter "${adapterName}" not found`);
    this.name = 'StorageAdapterNotFoundError';
    this.adapterName = adapterName;
  }
}

/** No writable adapter available */
export class StorageNoWritableAdapterError extends StorageError {
  constructor() {
    super('No writable adapter available');
    this.name = 'StorageNoWritableAdapterError';
  }
}

/** HTTP API error */
export class StorageApiError extends StorageError {
  statusCode: number;
  endpoint: string;

  constructor(statusCode: number, message: string, endpoint: string) {
    super(`API error ${statusCode}: ${message} (${endpoint})`);
    this.name = 'StorageApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

/** Local filesystem error */
export class StorageLocalError extends StorageError {
  originalError: Error;

  constructor(message: string, originalError: Error) {
    super(message);
    this.name = 'StorageLocalError';
    this.originalError = originalError;
  }
}
