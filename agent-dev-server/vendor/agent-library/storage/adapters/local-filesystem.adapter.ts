import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { AbstractStorageAdapter, type AdapterWriteOptions } from './abstract-storage-adapter.ts';
import type { RawFileMetadata, SearchOptions, SearchResult, SearchFileResult } from '../types.ts';
import { StorageLocalError } from '../types.ts';
import { getMimeType } from '../mime-utils.ts';
import { textSearch, truncateMatchContent } from '../search-utils.ts';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 256 * 1024;

/** Type guard for execFile errors which carry `code`, `stdout`, `stderr` */
function isExecError(
  error: unknown,
): error is Error & { code: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && 'code' in error;
}

export type LocalFileSystemAdapterParams = {
  /** Root directory path for local storage */
  basePath: string;

  /** Optional: whether the adapter is writable (default: false) */
  isWritable?: boolean;
};

/**
 * Storage adapter for local filesystem (readonly).
 *
 * - writable: false (local files are readonly)
 * - cacheableList: true (directory scanning is expensive)
 * - cacheableContent: false (local file reads are fast)
 */
export class LocalFileSystemAdapter extends AbstractStorageAdapter {
  #basePath: string;
  #isWritable: boolean = false;

  constructor(params: LocalFileSystemAdapterParams) {
    super();
    this.#basePath = path.resolve(params.basePath);
    if (params.isWritable !== undefined) {
      this.#isWritable = params.isWritable;
    }
  }

  // ============================================================================
  // Adapter Properties
  // ============================================================================

  get writable(): boolean {
    return this.#isWritable;
  }

  get cacheableList(): boolean {
    return true;
  }

  get cacheableContent(): boolean {
    return false;
  }

  override get searchable(): boolean {
    return true;
  }

  // ============================================================================
  // Search
  // ============================================================================

  override async search(
    pattern: string,
    options?: SearchOptions,
  ): Promise<SearchResult[] | SearchFileResult[]> {
    // When context is requested, fall back to in-process search for accurate
    // before/after lines. For everything else, use fast grep.
    if (options?.context && options.context > 0) {
      return this.#searchInProcess(pattern, options);
    }
    return this.#searchWithGrep(pattern, options);
  }

  async #searchWithGrep(
    pattern: string,
    options?: SearchOptions,
  ): Promise<SearchResult[] | SearchFileResult[]> {
    // -H: always print the filename (grep omits it for a single-file argument,
    // which breaks the `file:line:content` parser). -E: extended regex so `|`,
    // `()`, `+`, `{}` work, matching the in-process JS-regex search path.
    const args: string[] = ['-rnH', '-E', '--color=never'];

    if (options?.ignoreCase) {
      args.push('-i');
    }

    if (options?.filesOnly) {
      args.push('-l');
    }

    if (options?.include) {
      args.push(`--include=${options.include}`);
    }

    args.push('-e', pattern, '--');

    // Validate against the root (throws on traversal) before handing to grep,
    // and keep it relative so the `file:line:content` output stays relative.
    let searchPath = '.';
    if (options?.path) {
      const resolved = this.#resolvePath(options.path);
      searchPath = path.relative(this.#basePath, resolved) || '.';
    }
    args.push(searchPath);

    const cwd = this.#basePath;

    this.logger?.debug('storage:adapter:fs', `Grep search: pattern="${pattern}" cwd=${cwd}`);

    let stdout: string;
    try {
      const result = await execFileAsync('grep', args, { maxBuffer: MAX_BUFFER, cwd });
      stdout = result.stdout;
    } catch (error: unknown) {
      // grep exits with code 1 when no matches found — not an error.
      // execFile rejects on non-zero exit codes.
      if (isExecError(error) && error.code === 1) {
        return [];
      }
      // Buffer overflow: use partial output
      if (isExecError(error) && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        stdout = typeof error.stdout === 'string' ? error.stdout : '';
      } else {
        this.logger?.error('storage:adapter:fs', 'Grep search failed', error);
        throw new StorageLocalError(
          `Grep search failed for pattern: ${pattern}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    if (!stdout.trim()) {
      return [];
    }

    const lines = stdout.trimEnd().split('\n');
    const maxResults = options?.maxResults ?? lines.length;

    if (options?.filesOnly) {
      return parseGrepFileLines(lines, maxResults);
    }
    return parseGrepMatchLines(lines, maxResults, pattern);
  }

  async #searchInProcess(
    pattern: string,
    options: SearchOptions,
  ): Promise<SearchResult[] | SearchFileResult[]> {
    // Build a map of file path → content for textSearch
    const files = new Map<string, string>();
    const allFiles = await this.listFiles();

    for (const fileMeta of allFiles) {
      if (options.path && !fileMeta.path.startsWith(options.path)) continue;

      const content = await this.readFile(fileMeta.path);
      if (content !== null) {
        files.set(fileMeta.path, content.toString('utf-8'));
      }
    }

    return textSearch(files, pattern, options);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /** Resolve relative path to absolute path within base directory */
  #resolvePath(relativePath: string): string {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const resolved = path.resolve(this.#basePath, normalizedPath);

    // Security: prevent path traversal outside base directory
    if (!resolved.startsWith(this.#basePath)) {
      throw new StorageLocalError(
        `Path traversal attempt: ${relativePath}`,
        new Error('Path traversal'),
      );
    }

    return resolved;
  }

  // ============================================================================
  // Storage Operations
  // ============================================================================

  async readFile(filePath: string): Promise<Buffer | null> {
    const absolutePath = this.#resolvePath(filePath);
    this.logger?.debug('storage:adapter:fs', `Reading file: '${filePath}' (${absolutePath})`);

    try {
      const content = await fs.readFile(absolutePath);
      this.logger?.debug(
        'storage:adapter:fs',
        `Read successful: '${filePath}' (${content.length} bytes)`,
      );
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger?.debug('storage:adapter:fs', `File not found: '${filePath}'`);
        return null;
      }
      this.logger?.error('storage:adapter:fs', `Read failed: '${filePath}'`, error);
      throw new StorageLocalError(`Failed to read file: ${filePath}`, error as Error);
    }
  }

  async writeFile(
    filePath: string,
    content: Buffer,
    _contentType: string,
    _options?: AdapterWriteOptions,
  ): Promise<void> {
    if (!this.#isWritable) {
      throw new StorageLocalError(
        'LocalFileSystemAdapter is readonly',
        new Error('Write not supported'),
      );
    }
    const absolutePath = this.#resolvePath(filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
    this.logger?.debug(
      'storage:adapter:fs',
      `Write successful: '${filePath}' (${content.length} bytes)`,
    );
  }

  async deleteFile(filePath: string): Promise<void> {
    this.logger?.warn('storage:adapter:fs', `Delete attempt on readonly adapter: '${filePath}'`);
    throw new StorageLocalError(
      'LocalFileSystemAdapter is readonly',
      new Error('Delete not supported'),
    );
  }

  async listFiles(): Promise<RawFileMetadata[]> {
    this.logger?.debug('storage:adapter:fs', `Listing files from: ${this.#basePath}`);

    try {
      const entries = await fs.readdir(this.#basePath, {
        withFileTypes: true,
        recursive: true,
      });

      const files: RawFileMetadata[] = [];

      for (const entry of entries) {
        if (entry.isFile()) {
          // entry.parentPath is available in Node 20+ with recursive: true
          const relativePath = entry.parentPath
            ? path.relative(this.#basePath, path.join(entry.parentPath, entry.name))
            : entry.name;

          const fullPath = path.join(this.#basePath, relativePath);
          const stats = await fs.stat(fullPath);

          files.push({
            path: relativePath.replace(/\\/g, '/'), // Normalize to forward slashes
            size: stats.size,
            contentType: getMimeType(entry.name),
          });
        }
      }

      this.logger?.debug('storage:adapter:fs', `List complete: ${files.length} files`);
      return files;
    } catch (error) {
      // Missing base dir (a lazily-created branch not yet written to) is an empty listing,
      // not an error — mirrors readFile returning null for a missing file.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger?.debug('storage:adapter:fs', `List target missing, empty: ${this.#basePath}`);
        return [];
      }
      this.logger?.error('storage:adapter:fs', `List failed: ${this.#basePath}`, error);
      throw new StorageLocalError(`Failed to list files in ${this.#basePath}`, error as Error);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const absolutePath = this.#resolvePath(filePath);

    try {
      await fs.access(absolutePath);
      this.logger?.debug('storage:adapter:fs', `Exists check: '${filePath}' = true`);
      return true;
    } catch {
      this.logger?.debug('storage:adapter:fs', `Exists check: '${filePath}' = false`);
      return false;
    }
  }
}

/**
 * Parse `grep -rnH` output lines (`file:line:content`) into match results.
 * Strips a leading `./` from the file (grep emits it when searching `.`).
 * Match content is bounded via truncateMatchContent so a single long line
 * cannot dump kilobytes into results.
 */
export function parseGrepMatchLines(
  lines: string[],
  maxResults: number,
  pattern: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of lines) {
    if (results.length >= maxResults) break;

    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;

    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon).replace(/^\.\//, '');
    const lineNum = Number.parseInt(line.slice(firstColon + 1, secondColon), 10);
    const content = truncateMatchContent(line.slice(secondColon + 1), pattern);

    if (!Number.isNaN(lineNum)) {
      results.push({ file, line: lineNum, content });
    }
  }
  return results;
}

/** Parse `grep -l` output lines (one file path per line) into file results. */
export function parseGrepFileLines(lines: string[], maxResults: number): SearchFileResult[] {
  const results: SearchFileResult[] = [];
  for (const line of lines) {
    if (results.length >= maxResults) break;
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      results.push({ file: trimmed.replace(/^\.\//, '') });
    }
  }
  return results;
}
