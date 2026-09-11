import { AgentStorage } from '../../vendor/agent-library/storage/agent-storage.ts';
import { AgentPlaceApiAdapter } from '../../vendor/agent-library/storage/adapters/agentplace-api.adapter.ts';
import { LocalFileSystemAdapter } from '../../vendor/agent-library/storage/adapters/local-filesystem.adapter.ts';
import type { AbstractStorageAdapter } from '../../vendor/agent-library/storage/adapters/abstract-storage-adapter.ts';
import type { PathRoutingConfig } from '../../vendor/agent-library/storage/types.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Session sub-branches sharing the session's storage location, partitioned by
 * filename prefix. Single source of truth: `private` excludes these prefixes,
 * derived from this list — adding a sub-branch here is the only edit needed.
 */
const SESSION_SUBBRANCHES: ReadonlyArray<{ name: string; prefix: string }> = [
  { name: 'tool-results', prefix: 'tool-results/' },
];

export type InfraPathConfig = {
  name: string;
  basePath: string;
  writable?: boolean;
};

export type AgentStorageFactoryServiceParams = {
  /** API base URL (e.g., 'https://api.agentplace.io') */
  apiBaseUrl: string;
  /** Model access token for authentication */
  modelAccessToken: string;
};

/**
 * Factory service for creating AgentStorage instances with proper configuration.
 *
 * This service creates AgentStorage instances configured with AgentPlaceApiAdapter(s):
 * - One adapter for common storage (shared across sessions)
 * - Optionally, when a secretFolder is set, two more adapters for
 *   session-specific storage: private (secret/private data) and tool-results
 *   (durable, session-isolated tool-result offload storage)
 *
 * The AgentStorage instance includes built-in caching for performance optimization.
 */
export class AgentStorageFactoryService {
  #apiBaseUrl: string;
  #modelAccessToken: string;
  #storageCache: Map<string, AgentStorage>;
  #infraPaths: InfraPathConfig[] | null = null;
  #pathRouting: PathRoutingConfig | null = null;

  constructor(params: AgentStorageFactoryServiceParams) {
    this.#apiBaseUrl = params.apiBaseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.#modelAccessToken = params.modelAccessToken;
    this.#storageCache = new Map();
  }

  /**
   * Configure infrastructure paths that will be included in all subsequent
   * storage instances. Call once at startup; the config applies to every
   * `createStorage` / `getStorage` call after this point.
   */
  setInfraConfig(infraPaths: InfraPathConfig[], pathRouting: PathRoutingConfig): void {
    this.#infraPaths = infraPaths;
    this.#pathRouting = pathRouting;
  }

  /**
   * Create a new AgentStorage instance with configured adapters.
   *
   * @param secretFolder - Optional secret folder for private storage isolation.
   *                       If provided, creates three adapters (private +
   *                       tool-results + common); tool-results is scoped under
   *                       `${secretFolder}/tool-results`, so a session can only
   *                       ever resolve its own offloaded results. If not
   *                       provided, creates one adapter (common only).
   * @param options - Additional configuration options
   * @returns Configured AgentStorage instance with caching enabled
   */
  createStorage(
    secretFolder?: string,
    options?: {
      /** Enable debug logging (default: false) */
      debugEnabled?: boolean;
      /** Cache TTL in milliseconds (default: 5 minutes) */
      cacheTtl?: number;
      /** Enable compression for uploads/downloads (default: false) */
      compression?: boolean;
    },
  ): AgentStorage {
    const { debugEnabled = false, cacheTtl, compression = false } = options ?? {};

    const adapters: Array<{
      name: string;
      adapter: AbstractStorageAdapter;
    }> = [];

    if (secretFolder) {
      adapters.push({
        name: 'private',
        adapter: new AgentPlaceApiAdapter({
          apiBaseUrl: this.#apiBaseUrl,
          accessKey: this.#modelAccessToken,
          secretFolder,
          compression,
          excludePrefixes: SESSION_SUBBRANCHES.map((b) => b.prefix),
        }),
      });
      for (const branch of SESSION_SUBBRANCHES) {
        adapters.push({
          name: branch.name,
          adapter: new AgentPlaceApiAdapter({
            apiBaseUrl: this.#apiBaseUrl,
            accessKey: this.#modelAccessToken,
            secretFolder,
            compression,
            filePrefix: branch.prefix,
          }),
        });
      }
    }

    adapters.push({
      name: 'common',
      adapter: new AgentPlaceApiAdapter({
        apiBaseUrl: this.#apiBaseUrl,
        accessKey: this.#modelAccessToken,
        compression,
      }),
    });

    // Infrastructure adapters (local filesystem paths for source, logs, etc.)
    if (this.#infraPaths) {
      for (const infra of this.#infraPaths) {
        adapters.push({
          name: infra.name,
          adapter: new LocalFileSystemAdapter({
            basePath: infra.basePath,
            isWritable: infra.writable ?? false,
          }),
        });
      }
    }

    const agentPath = path.join(__dirname, '..', '..', '.agent');

    adapters.push({
      name: 'local',
      adapter: new LocalFileSystemAdapter({
        basePath: agentPath,
      }),
    });

    return new AgentStorage({
      adapters,
      pathRouting: this.#pathRouting ?? undefined,
      cacheEnabled: true, // Always enable cache for performance
      cacheTtl,
      debugEnabled,
    });
  }

  /**
   * Get or create an AgentStorage instance with caching.
   * Returns existing instance from cache if available, otherwise creates a new one.
   *
   * @param secretFolder - Optional secret folder for private storage isolation.
   * @param options - Additional configuration options
   * @returns Cached or newly created AgentStorage instance
   */
  getStorage(secretFolder?: string): AgentStorage {
    // Create cache key based on secretFolder
    const cacheKey = secretFolder || '__common__';

    // Check if instance already exists in cache
    if (this.#storageCache.has(cacheKey)) {
      return this.#storageCache.get(cacheKey);
    }

    // Create new instance
    const storage = this.createStorage(secretFolder);

    // Cache it
    this.#storageCache.set(cacheKey, storage);

    return storage;
  }

  /**
   * Clear the storage cache. Useful for testing or when you need to force recreation.
   */
  clearCache(): void {
    this.#storageCache.clear();
  }

  /**
   * Get the configured API base URL
   */
  getApiBaseUrl(): string {
    return this.#apiBaseUrl;
  }

  /**
   * Get the model access token used for API authentication
   */
  getAccessKey(): string {
    return this.#modelAccessToken;
  }
}

export default AgentStorageFactoryService;
