import { z } from 'zod';
import {
  ToolModel,
  type AgentState,
  type ToolExecuteContext,
  type ToolExecuteResult,
  type ToolOutputMultiContent,
  type AgentStorage,
  type DirectoryTreeNode,
  capFileContent,
  applySearchReplaceEditsToContent,
  StorageFileNotFoundError,
  StorageAdapterNotFoundError,
  listBranchRelativePaths,
  listDirRelativePaths,
  buildTreeFromRelativeFileList,
  filterStructure,
  limitDepth,
  pruneNoiseDirs,
  structureToText,
} from '../../agent/agent-library.ts';
import type { AgentStorageFactoryService } from '../../../services/agent-storage-factory.service.ts';
import { getSessionKey, type DevServerAppState } from '../../agent/agent-state.ts';
import { FileReferenceLoader } from './file-reference-loader.ts';
import {
  classifyFileForView,
  resizeImageToJpeg,
  extractDocumentText,
  sniffMimeFromName,
  HEIC_HINT,
  PPTX_HINT,
  HTML_HINT,
} from './file-decode.ts';

const FilesystemSchema = z.object({
  command: z
    .enum(['view', 'write', 'edit'])
    .describe(
      '"view" to read a file or list a directory; "write" to create/overwrite a file; ' +
        '"edit" to change parts of an existing file in place via SEARCH/REPLACE blocks.',
    ),

  path: z
    .string()
    .optional()
    .describe(
      'For "view": a storage path (e.g. private/notes.md), a branch or directory (e.g. source/, ' +
        'common/), an agent-storage:<branch>/<name> reference, or an https:// URL — omit to list ' +
        'the storage root. For "write": the destination path (an unprefixed name goes to private/). ' +
        'For "edit": the path of an existing writable file. See the description for writable branches.',
    ),

  content: z
    .string()
    .optional()
    .describe(
      'For "write": the full file content. For "edit": one or more SEARCH/REPLACE blocks ' +
        '(see the tool description). Required for both.',
    ),

  // NOTE: a fixed-length array, NOT z.tuple — tuple schemas convert to
  // list-form `items: [a, b]`, which Gemini/Vertex's proto rejects
  // ("Proto field is not repeating, cannot start list").
  view_range: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe(
      'View a 1-based [start, end] line range of a text file (end -1 = end of file; line numbers ' +
        'match Grep). Applies only to a text file; ignored (with a note) for images, decoded documents, and directories.',
    ),

  depth: z
    .number()
    .int()
    .optional()
    .describe(
      'Directory view only: tree depth. Default 1 (immediate children). Pass a larger number to go deeper.',
    ),
});

type FilesystemInput = z.infer<typeof FilesystemSchema>;

const TOOL_DESCRIPTION = `Read and manage files in your agent storage.

Files are for documents and artifacts — notes, generated content, uploads. NEVER store business facts (bookings, customers, requests, …) in files: anything you would look up, count, or correct as an entry goes through the records tool, where it stays queryable and administrable.

view — read a file, or list a directory.
  • File path → its content. Text is returned raw; pass view_range for a line slice (line numbers
    match Grep — for a large file or tool-result, Grep for the line then view that range). Images
    and PDF/Word/Excel are decoded for you (documents → extracted text; layout/figures are lost).
  • The path may be a storage path, an agent-storage:<branch>/<name> reference, or an https:// URL.
    For view these are equivalent: private/notes.md ≡ agent-storage:private/notes.md. For an HTML
    web page use the page-fetcher subagent, not view.
  • Directory path, or no path → a directory tree (default depth 1; raise depth for more levels).
    Two branches are read & write — private/ (this session) and common/ (shared across your
    sessions, permanent); the rest (source/, tool-results/) are read-only. An https:// URL
    is readable but never appears in a listing.

write — create or fully overwrite a file. Write only to private/ or common/. A bare name
  (notes.md) and the explicit private/notes.md are equivalent — both go to private/; use
  common/<name> to persist across sessions. Filenames are ASCII only: letters, digits, -, _,
  ., and space (no leading dot, no non-ASCII characters).

edit — change parts of an existing file in place (instead of rewriting it whole). Put one or more
  SEARCH/REPLACE blocks in content, each shaped exactly:
      ------- SEARCH
      <exact current text to find>
      =======
      <replacement text>
      +++++++ REPLACE
  Each SEARCH must match the current file content uniquely. All blocks are applied together or
  none are (if any block fails to match, nothing is written and the failures are reported). Same
  writable branches as write (private/, common/).

To show a stored file with the Image tool or offer it with FileDownload, reference it the same
way you'd address it here: agent-storage:private/<name> (this session) or agent-storage:common/<name>.`;

export class FilesystemTool extends ToolModel<FilesystemInput> {
  #storageFactory: AgentStorageFactoryService;
  readonly #loader: FileReferenceLoader;
  readonly #sessionKey: string | undefined;

  constructor(params: {
    storageFactory: AgentStorageFactoryService;
    sessionKey?: string;
  }) {
    super({
      name: 'filesystem',
      description: TOOL_DESCRIPTION,
      parametersSchema: FilesystemSchema,
      toolType: 'function',
      isStrict: false,
      skipOffload: true,
    });

    this.#storageFactory = params.storageFactory;
    this.#loader = new FileReferenceLoader({ storageFactory: params.storageFactory });
    this.#sessionKey = params.sessionKey;
  }

  async execute(input: FilesystemInput, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    if (ctx.abortSignal?.aborted) {
      return { output: 'Canceled.', uiProps: { command: input.command } };
    }

    const agentState = ctx.runner.state as AgentState<unknown, DevServerAppState>;
    const secretFolder = getSessionKey(agentState) ?? this.#sessionKey;

    try {
      switch (input.command) {
        case 'view':
          return await this.#handleView(input, ctx, secretFolder);
        case 'write':
          return await this.#handleWrite(input, secretFolder);
        case 'edit':
          return await this.#handleEdit(input, secretFolder);
        default:
          return {
            output: `Unknown command: ${input.command}`,
            uiProps: { error: 'Invalid command' },
          };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        output: `Filesystem error (${input.command}): ${errorMsg}`,
        uiProps: { error: errorMsg, command: input.command },
      };
    }
  }

  async #handleView(
    input: FilesystemInput,
    ctx: ToolExecuteContext,
    secretFolder: string | undefined,
  ): Promise<ToolExecuteResult> {
    const storage = this.#storageFactory.getStorage(secretFolder);
    const raw = (input.path ?? '').trim();
    const depth = input.depth ?? 1;

    if (depth < 1) {
      return { output: 'depth must be a positive integer (>= 1).', uiProps: { command: 'view' } };
    }

    if (/^https?:\/\//i.test(raw)) {
      return this.#viewReference(raw, input, secretFolder, ctx.abortSignal, true);
    }

    if (raw.startsWith('agent-storage:')) {
      return this.#viewReference(raw, input, secretFolder, ctx.abortSignal, false);
    }

    if (raw === '') {
      const tree = await this.#buildRootTree(storage, depth);
      return this.#noteIgnoredViewRange(this.#renderTree(tree, '', depth), input);
    }

    const isBareBranch = !raw.includes('/') && this.#branchNames(storage).includes(raw);
    if (raw.endsWith('/') || isBareBranch) {
      return this.#noteIgnoredViewRange(await this.#viewDirectory(storage, raw, depth), input);
    }

    // No defaultAdapter: a bare unrouted read throws StorageFileNotFoundError, so fall back to a listing.
    try {
      return await this.#viewStorageFile(storage, raw, input);
    } catch (error) {
      if (error instanceof StorageFileNotFoundError) {
        return this.#noteIgnoredViewRange(await this.#viewDirectory(storage, raw, depth), input);
      }
      throw error;
    }
  }

  #noteIgnoredViewRange(result: ToolExecuteResult, input: FilesystemInput): ToolExecuteResult {
    if (!input.view_range || typeof result.output !== 'string') {
      return result;
    }
    return {
      ...result,
      output: `${result.output}\n\n(view_range ignored: it applies only to a text file.)`,
    };
  }

  #branchNames(storage: AgentStorage): string[] {
    return storage.getAdapterNames().filter((name) => storage.getRoutingPrefix(name) !== '');
  }

  async #viewStorageFile(
    storage: AgentStorage,
    path: string,
    input: FilesystemInput,
  ): Promise<ToolExecuteResult> {
    const buffer = await storage.readFile(path);
    const filename = path.split('/').pop() || path;
    const mediaType = sniffMimeFromName(filename);
    return this.#renderFileContent(buffer, filename, mediaType, input, false);
  }

  async #viewReference(
    reference: string,
    input: FilesystemInput,
    secretFolder: string | undefined,
    abortSignal: AbortSignal | undefined,
    fromUrl: boolean,
  ): Promise<ToolExecuteResult> {
    const loaded = await this.#loader.load(reference, { signal: abortSignal, secretFolder });
    if ('error' in loaded) {
      return {
        output: `Could not read "${loaded.filename}": ${loaded.error}`,
        uiProps: { command: 'view', path: reference, error: loaded.error },
      };
    }
    return this.#renderFileContent(loaded.bytes, loaded.filename, loaded.mediaType, input, fromUrl);
  }

  async #renderFileContent(
    bytes: Buffer,
    filename: string,
    mediaType: string,
    input: FilesystemInput,
    fromUrl: boolean,
  ): Promise<ToolExecuteResult> {
    const kind = classifyFileForView(filename, mediaType);

    if (kind === 'text' || (kind === 'html' && !fromUrl)) {
      return this.#renderTextFile(bytes, filename, input.view_range);
    }

    const warn = input.view_range ? ' (view_range ignored: it applies only to a text file.)' : '';

    if (kind === 'image') {
      let jpeg: Buffer;
      try {
        jpeg = await resizeImageToJpeg(bytes);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          output: `Could not process image "${filename}": ${msg}`,
          uiProps: { command: 'view', path: filename, error: msg },
        };
      }
      const content: ToolOutputMultiContent = {
        type: 'multi-content',
        description: `Read image "${filename}".${warn}`,
        parts: [
          {
            kind: 'image',
            image: { data: new Uint8Array(jpeg), mediaType: 'image/jpeg', filename },
          },
        ],
      };
      return { output: content, uiProps: { command: 'view', path: filename, kind: 'image' } };
    }

    if (kind === 'document') {
      let extracted: string;
      try {
        extracted = await extractDocumentText(bytes, filename, mediaType);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          output: `Could not extract text from "${filename}": ${msg}`,
          uiProps: { command: 'view', path: filename, error: msg },
        };
      }
      return {
        output: `=== ${filename} ===\n${extracted}${warn}`,
        uiProps: { command: 'view', path: filename, kind: 'document' },
      };
    }

    let hint = HTML_HINT;
    if (kind === 'pptx') {
      hint = PPTX_HINT;
    } else if (kind === 'heic') {
      hint = HEIC_HINT;
    }
    return {
      output: `Cannot view "${filename}": ${hint}`,
      uiProps: { command: 'view', path: filename, error: hint },
    };
  }

  #renderTextFile(
    bytes: Buffer,
    filename: string,
    viewRangeInput: FilesystemInput['view_range'],
  ): ToolExecuteResult {
    const range = viewRangeInput
      ? { startLine: viewRangeInput[0], endLine: viewRangeInput[1] }
      : undefined;
    const { content, viewRange } = this.#applyViewRange(bytes.toString('utf8'), range);
    const header = viewRange
      ? `File "${filename}" (lines ${viewRange.startLine}-${viewRange.endLine} of ${viewRange.totalLines}):`
      : `File "${filename}" read successfully (${bytes.length} bytes):`;

    return {
      output: `${header}\n\n${content}`,
      uiProps: { command: 'view', path: filename, size: bytes.length, viewRange },
    };
  }

  #applyViewRange(
    text: string,
    range: { startLine?: number; endLine?: number } | undefined,
  ): { content: string; viewRange?: { startLine: number; endLine: number; totalLines: number } } {
    if (!range || (!range.startLine && !range.endLine)) {
      const cap = capFileContent(text);
      if (cap.capped) {
        return {
          content: cap.content,
          viewRange: { startLine: 1, endLine: cap.returnedLines, totalLines: cap.totalLines },
        };
      }
      return { content: text };
    }

    const lines = text.split('\n');
    // Don't count the phantom empty element a trailing newline adds (match Grep numbering).
    const totalLines =
      lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    const start = Math.max(1, range.startLine ?? 1);
    const endRaw = range.endLine ?? totalLines;
    const end = endRaw === -1 ? totalLines : Math.min(totalLines, endRaw);
    const safeStart = Math.max(1, Math.min(start, totalLines === 0 ? 1 : totalLines));
    const safeEnd = Math.max(safeStart, Math.min(end, totalLines));

    return {
      content: lines.slice(safeStart - 1, safeEnd).join('\n'),
      viewRange: { startLine: safeStart, endLine: safeEnd, totalLines },
    };
  }

  async #buildRootTree(storage: AgentStorage, depth: number): Promise<DirectoryTreeNode> {
    const branches = this.#branchNames(storage);

    if (depth <= 1) {
      return { name: '.', children: branches.map((name) => ({ name, children: [] })) };
    }

    const allPaths: string[] = [];
    for (const branch of branches) {
      const rel = await listBranchRelativePaths(storage, branch);
      for (const r of rel) {
        allPaths.push(`${branch}/${r}`);
      }
    }
    const root = buildTreeFromRelativeFileList(allPaths, '.');
    root.children = root.children ?? [];
    for (const branch of branches) {
      if (!root.children.some((child) => child.name === branch)) {
        root.children.push({ name: branch, children: [] });
      }
    }
    return limitDepth(root, depth);
  }

  async #viewDirectory(
    storage: AgentStorage,
    rawPath: string,
    depth: number,
  ): Promise<ToolExecuteResult> {
    let routePath = rawPath.replace(/^\.?\//, '');
    if (routePath !== '' && !routePath.includes('/')) {
      routePath = `${routePath}/`;
    }

    let listing: Awaited<ReturnType<typeof listDirRelativePaths>>;
    try {
      listing = await listDirRelativePaths(storage, routePath);
    } catch (error) {
      if (error instanceof StorageAdapterNotFoundError) {
        return {
          output: `No file or directory found at: ${rawPath}`,
          uiProps: { command: 'view', path: rawPath },
        };
      }
      throw error;
    }

    const { subPath, relativePaths } = listing;
    if (relativePaths.length === 0) {
      return {
        output: `No files found under: ${rawPath}`,
        uiProps: { command: 'view', path: rawPath },
      };
    }

    const tree = buildTreeFromRelativeFileList(relativePaths, '.');
    const filtered = filterStructure(tree, subPath, depth);
    if (!filtered) {
      return {
        output: `Directory not found: ${rawPath}`,
        uiProps: { command: 'view', path: rawPath },
      };
    }

    return this.#renderTree(filtered, rawPath, depth);
  }

  #renderTree(node: DirectoryTreeNode, label: string, depth: number): ToolExecuteResult {
    const treeToShow = pruneNoiseDirs(node);
    const originalTop = new Set((node.children ?? []).map((c) => c.name));
    const cleanedTop = new Set((treeToShow.children ?? []).map((c) => c.name));
    const removed = [...originalTop].filter((n) => !cleanedTop.has(n));
    const hiddenHint = removed.length > 0 ? `\n\n(Hidden: ${removed.join(', ')}.)` : '';

    const treeText = structureToText(treeToShow);
    const header = label
      ? `Directory listing for "${label}" (depth: ${depth}):`
      : `Storage root (depth: ${depth}):`;

    return {
      output: `${header}\n\n${treeText}${hiddenHint}`,
      uiProps: { command: 'view', path: label, depth },
    };
  }

  async #handleWrite(
    input: FilesystemInput,
    secretFolder: string | undefined,
  ): Promise<ToolExecuteResult> {
    if (!input.path) {
      throw new Error('path is required for write');
    }
    if (input.content === undefined) {
      throw new Error('content is required for write');
    }

    const storage = this.#storageFactory.getStorage(secretFolder);
    const buffer = Buffer.from(input.content, 'utf8');

    await storage.writeFile(input.path, buffer);

    return {
      output: `File "${input.path}" written successfully (${buffer.length} bytes).`,
      uiProps: {
        command: 'write',
        path: input.path,
        size: buffer.length,
      },
    };
  }

  async #handleEdit(
    input: FilesystemInput,
    secretFolder: string | undefined,
  ): Promise<ToolExecuteResult> {
    if (!input.path) {
      throw new Error('path is required for edit');
    }
    if (input.content === undefined) {
      throw new Error('content is required for edit (SEARCH/REPLACE blocks)');
    }

    const storage = this.#storageFactory.getStorage(secretFolder);

    let original: string;
    try {
      original = (await storage.readFile(input.path)).toString('utf8');
    } catch (error) {
      if (error instanceof StorageFileNotFoundError) {
        return {
          output: `Cannot edit "${input.path}": no such file. Use write to create it first.`,
          uiProps: { command: 'edit', path: input.path, error: 'not found' },
        };
      }
      throw error;
    }

    const report = applySearchReplaceEditsToContent(input.path, original, input.content);

    if (report.failures.length > 0 || report.totalEditsApplied === 0) {
      const reason =
        report.failures.map((f) => f.message).join('; ') || 'no SEARCH/REPLACE blocks found';
      return {
        output: `No changes written to "${input.path}" — ${reason}. Edits are all-or-nothing: fix the SEARCH/REPLACE blocks and retry.`,
        uiProps: { command: 'edit', path: input.path, error: reason },
      };
    }

    // A block can "apply" yet leave content identical (SEARCH == REPLACE) — skip the write.
    if (report.newContent === original) {
      return {
        output: `No changes needed for "${input.path}": the file already matches the requested edit.`,
        uiProps: { command: 'edit', path: input.path, editsApplied: 0 },
      };
    }

    await storage.writeFile(input.path, Buffer.from(report.newContent, 'utf8'));

    return {
      output: `Edited "${input.path}": ${report.totalEditsApplied} change(s) applied.`,
      uiProps: { command: 'edit', path: input.path, editsApplied: report.totalEditsApplied },
    };
  }
}
