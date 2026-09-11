import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';
import { listDirRelativePaths } from '../storage/storage-tree.ts';
import { getAgentLogger } from '../types/logger.ts';
import {
  type DirectoryTreeNode,
  buildTreeFromRelativeFileList,
  filterStructure,
  pruneNoiseDirs,
  structureToText,
} from '../util/directory-tree.ts';
import { z } from 'zod';

const COMPONENT_NAME = 'ListDirectory';

const listDirectorySchema = z.object({
  baseDir: z
    .string()
    .describe(
      'Directory to list. Use "" or "." for the project root, a subdirectory like "agent-dev-client/src", or a storage branch prefix like "tool-results/", "logs/", "files/".',
    ),
  depth: z
    .number()
    .optional()
    .describe(
      'Optional: Maximum depth to traverse. If not specified, will show the full tree. Use 1 for immediate children only, 2 for two levels deep, etc.',
    ),
  showAll: z
    .boolean()
    .optional()
    .describe(
      'Default false. Set true to include normally-hidden noise directories (node_modules, build, dist, .git, .next, .turbo, coverage, .DS_Store, .vscode, .idea). Only use when you specifically need to inspect a dependency or build artifact.',
    ),
});
type ListDirectoryToolArgs = z.infer<typeof listDirectorySchema>;

type ListDirectoryToolParams = {
  agentStorage: AgentStorage;
};

export class ListDirectoryTool extends ToolModel<ListDirectoryToolArgs> {
  #agentStorage: AgentStorage;

  constructor(params: ListDirectoryToolParams) {
    super({
      name: COMPONENT_NAME,
      description: `List files in agent storage. Defaults to the project source tree; use a branch prefix to list other storage areas.

Storage branches:
  - "source/" or "" — project source files (returns a directory tree)
  - "tool-results/" — stored tool results from this session
  - "logs/" — historical runtime log files
  - "files/" — user-uploaded files

Use this to explore project structure, find files, or discover what is stored in tool-results or logs.`,
      toolType: 'function',
      isStreaming: false,
      parametersSchema: listDirectorySchema,
    });
    this.#agentStorage = params.agentStorage;
  }

  getComponentName(): string {
    return COMPONENT_NAME;
  }

  async execute(
    input: ListDirectoryToolArgs,
    _ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    const logger = getAgentLogger();
    logger.info('[ListDirectoryTool] execute', { baseDir: input.baseDir, depth: input.depth });

    const { baseDir, depth } = input;

    if (baseDir === undefined || baseDir === null || typeof baseDir !== 'string') {
      const errorMsg = 'baseDir is required and must be a string';
      return { output: errorMsg, uiProps: { error: errorMsg } };
    }

    if (depth !== undefined && (typeof depth !== 'number' || depth < 1)) {
      const errorMsg = 'depth must be a positive number if provided';
      return { output: errorMsg, uiProps: { error: errorMsg } };
    }

    try {
      // Lists the resolved branch and folds in any overlay branch nested under it
      // (e.g. a skills branch mounted under the source tree). Non-overlapping
      // branches are not walked, so listing one top-level branch stays scoped.
      const { subPath, relativePaths } = await listDirRelativePaths(this.#agentStorage, baseDir);

      if (relativePaths.length === 0) {
        const errorMsg = `No files found under: ${baseDir}`;
        return { output: errorMsg, uiProps: { error: errorMsg } };
      }

      const tree = buildTreeFromRelativeFileList(relativePaths, '.');
      const filtered = filterStructure(tree, subPath, depth);

      if (!filtered) {
        const errorMsg = `Directory not found: ${baseDir}`;
        return { output: errorMsg, uiProps: { error: errorMsg } };
      }

      return this.#renderTree(filtered, baseDir, depth, input.showAll ?? false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[ListDirectoryTool] error', { message });
      return {
        output: `Error listing directory: ${message}`,
        uiProps: { error: `Error listing directory: ${message}` },
      };
    }
  }

  /**
   * Prune noise dirs (node_modules, build, dist, .git, …) unless `showAll`,
   * surface which top-level dirs were hidden, and render as text.
   */
  #renderTree(
    filtered: DirectoryTreeNode,
    baseDir: string,
    depth: number | undefined,
    showAll: boolean,
  ): ToolExecuteResult {
    let treeToShow: DirectoryTreeNode;
    let hiddenHint = '';
    if (showAll) {
      treeToShow = filtered;
    } else {
      treeToShow = pruneNoiseDirs(filtered);
      const originalTop = new Set((filtered.children ?? []).map((c) => c.name));
      const cleanedTop = new Set((treeToShow.children ?? []).map((c) => c.name));
      const removed = [...originalTop].filter((n) => !cleanedTop.has(n));
      if (removed.length > 0) {
        hiddenHint = `\n\n(Hidden at this level: ${removed.join(', ')}. Pass showAll:true to include, or use baseDir to descend into one.)`;
      }
    }

    const textRepresentation = structureToText(treeToShow);
    const output = `Directory listing for "${baseDir}"${depth ? ` (depth: ${depth})` : ''}:\n\n${textRepresentation}${hiddenHint}`;

    return {
      output,
      uiProps: { structure: treeToShow, baseDir, depth, showAll },
    };
  }
}
