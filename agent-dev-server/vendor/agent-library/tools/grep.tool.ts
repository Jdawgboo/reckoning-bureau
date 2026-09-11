import { z } from 'zod';
import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';
import type { SearchResult, SearchFileResult } from '../storage/types.ts';
import { getAgentLogger } from '../types/logger.ts';

const COMPONENT_NAME = 'Grep';
const MAX_OUTPUT_CHARS = 50_000;

const grepSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for (grep -e).'),
  path: z
    .string()
    .optional()
    .describe(
      'Scope search to a branch or path prefix, e.g. a branch root ("source/") or a subpath within it.',
    ),
  include: z.string().optional().describe('File glob filter (grep --include). Example: "*.ts"'),
  ignoreCase: z.boolean().optional().describe('Case-insensitive search (grep -i). Default: false.'),
  context: z
    .number()
    .optional()
    .describe('Lines of context around each match (grep -C). Default: 0.'),
  maxCount: z.number().optional().describe('Maximum matches to return (grep -m). Default: 100.'),
  filesOnly: z
    .boolean()
    .optional()
    .describe('Return only file paths containing matches (grep -l). Default: false.'),
});

type GrepArgs = z.infer<typeof grepSchema>;

/**
 * Group matches by file so each path is printed once as a header, with its
 * matching lines beneath as `  <line>: <content>`. Avoids repeating the full
 * path on every match line. Context lines (grep -C) carry content only — no line
 * numbers — so they render indented under their match without the path.
 */
export function formatGroupedMatches(results: (SearchResult | SearchFileResult)[]): string {
  const byFile = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (!('line' in r)) {
      continue;
    }
    const matches = byFile.get(r.file) ?? [];
    matches.push(r);
    byFile.set(r.file, matches);
  }

  const blocks: string[] = [];
  for (const [file, matches] of byFile) {
    const lines: string[] = [`${file}:`];
    for (const m of matches) {
      for (const before of m.context?.before ?? []) {
        lines.push(`  ${before}`);
      }
      lines.push(`  ${m.line}: ${m.content}`);
      for (const after of m.context?.after ?? []) {
        lines.push(`  ${after}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function buildScopeDescription(path: string | undefined): string {
  if (!path) {
    return '';
  }
  return ` in "${path}"`;
}

export class GrepTool extends ToolModel<GrepArgs> {
  #agentStorage: AgentStorage;

  constructor({
    agentStorage,
    description,
  }: {
    agentStorage: AgentStorage;
    /** Overrides the branch-agnostic default; consumers name their own branches. */
    description?: string;
  }) {
    super({
      name: COMPONENT_NAME,
      description:
        description ??
        'Search for text patterns across agent storage using regex (grep). ' +
          'Use the "path" parameter to scope the search to a branch or directory; ' +
          'omit it to search all searchable branches at once. ' +
          'Long lines are returned as a bounded excerpt, matches and context alike. ' +
          'Supports case-insensitive search, file glob filters, context lines, and files-only mode.',
      toolType: 'function',
      isStreaming: false,
      parametersSchema: grepSchema,
    });
    this.#agentStorage = agentStorage;
  }

  getComponentName(): string {
    return COMPONENT_NAME;
  }

  /**
   * On zero matches within an explicit path, report how many files that scope
   * actually holds — "0 files" points at a wrong path, a positive count at an
   * absent pattern.
   */
  async #describeEmptyScope(path: string | undefined): Promise<string> {
    if (!path) {
      return '';
    }
    try {
      const { adapter, relativePath } = this.#agentStorage.resolvePath(path);
      const files = await this.#agentStorage.listFiles([adapter]);
      // Directory-boundary match, not raw prefix: a typo'd path must count 0
      // ("check the path"), never claim sibling-prefixed files were searched.
      const count =
        relativePath === ''
          ? files.length
          : files.filter((f) => f.path === relativePath || f.path.startsWith(`${relativePath}/`))
              .length;
      if (count === 0) {
        return ' The path contains no files — check the path.';
      }
      return ` Searched ${count} file(s) in this path.`;
    } catch {
      return '';
    }
  }

  async execute(input: GrepArgs, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const logger = getAgentLogger();
    const { pattern, path, include, ignoreCase, context, maxCount, filesOnly } = input;
    const maxResults = maxCount ?? 100;

    logger.info(
      `[GrepTool] Searching pattern="${pattern}" path=${path ?? '(all)'} include=${include ?? '(none)'} ignoreCase=${ignoreCase ?? false} context=${context ?? 0} maxResults=${maxResults} filesOnly=${filesOnly ?? false}`,
    );

    let results: (SearchResult | SearchFileResult)[];
    try {
      results = await this.#agentStorage.search(pattern, {
        path,
        include,
        ignoreCase,
        context,
        maxResults,
        filesOnly,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[GrepTool] Search failed: ${message}`);
      return {
        output: `Search failed: ${message}`,
        uiProps: { error: 'Search failed' },
      };
    }

    if (ctx.runner.abortSignal?.aborted) {
      return {
        output: 'Search canceled by user.',
        uiProps: { error: 'Canceled', isLoading: false },
      };
    }

    if (results.length === 0) {
      const scope = buildScopeDescription(path);
      const scopeHint = await this.#describeEmptyScope(path);
      return {
        output: `No matches found for pattern "${pattern}"${scope}.${scopeHint}`,
        uiProps: { totalMatches: 0 },
      };
    }

    let output = filesOnly ? results.map((r) => r.file).join('\n') : formatGroupedMatches(results);
    let truncated = false;
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS);
      truncated = true;
    }

    if (truncated) {
      output +=
        '\n\n--- Output truncated. Use a more specific path or pattern to narrow results. ---';
    }

    return {
      output,
      uiProps: { totalMatches: results.length },
    };
  }
}
