import { z } from 'zod';
import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';
import { getAgentLogger } from '../types/logger.ts';
import { capFileContent } from './file-line-cap.ts';

const viewRangeObjectSchema = z.object({
  startLine: z.number().int().min(1).optional().describe('Starting line number (1-based)'),
  endLine: z
    .number()
    .int()
    .optional()
    .describe('Ending line number (inclusive). Use -1 for end of file'),
});

// The [start, end] form matches the range format most models default to from
// training (e.g. the Anthropic text editor's `view_range`), so it is accepted
// as-is instead of bouncing the call on validation. Kept as a bounded array
// rather than z.tuple: tuples emit list-form `items`, which the Gemini proto
// rejects — failing the whole tool list, not just this tool.
const viewRangeSchema = z.union([viewRangeObjectSchema, z.array(z.number().int()).min(2).max(2)]);

const readFilesSchema = z.object({
  reasoning: z
    .string()
    .describe(
      'The reasoning for reading these files. Provide point from plan that is related to reading files if exists.',
    ),
  paths: z.array(z.string()).describe('The paths to the files to read'),
  viewRanges: z
    .array(viewRangeSchema)
    .optional()
    .describe(
      'Optional line ranges for each path (same order as paths). Each range is {"startLine": 601, "endLine": 1200} or [601, 1200]. If not provided or empty, reads entire file.',
    ),
});
type ReadFilesArgs = z.infer<typeof readFilesSchema>;
type ViewRange = z.infer<typeof viewRangeObjectSchema>;

function normalizeViewRange(
  range: z.infer<typeof viewRangeSchema> | undefined,
): ViewRange | undefined {
  if (Array.isArray(range)) {
    return { startLine: range[0], endLine: range[1] };
  }
  return range;
}

const COMPONENT_NAME = 'ReadFiles';

type FileResultEntry =
  | { filePath: string; error: string }
  | {
      filePath: string;
      content: string;
      viewRange?: { startLine: number; endLine: number; totalLines: number };
    };

/** Format file results as human-readable text with section headers. */
function formatFilesOutput(results: FileResultEntry[]): string {
  const parts: string[] = [];

  for (const result of results) {
    if ('error' in result) {
      parts.push(`=== ${result.filePath} ===\nError: ${result.error}`);
      continue;
    }

    const header =
      result.viewRange != null
        ? `=== ${result.filePath} (lines ${result.viewRange.startLine}-${result.viewRange.endLine} of ${result.viewRange.totalLines}) ===`
        : `=== ${result.filePath} (${result.content.split('\n').length} lines) ===`;

    parts.push(`${header}\n${result.content}`);
  }

  return parts.join('\n\n');
}

export class ReadFilesTool extends ToolModel<ReadFilesArgs> {
  #agentStorage: AgentStorage;

  constructor(params: { agentStorage: AgentStorage }) {
    super({
      name: 'ReadFiles',
      description:
        'Read one or more files from agent storage. Paths without a branch prefix default to "source/" (project files).\n' +
        'Use explicit prefixes to read from other branches:\n' +
        '  - "source/" — project source files (default)\n' +
        '  - "tool-results/" — stored tool results from this session\n' +
        '  - "logs/" — historical runtime logs (server + client)\n' +
        '  - "files/" — user-uploaded files\n' +
        'Supports reading specific line ranges via viewRanges parameter.',
      toolType: 'function',
      isStreaming: false,
      parametersSchema: readFilesSchema,
      skipOffload: true,
    });
    this.#agentStorage = params.agentStorage;
  }

  getComponentName(): string {
    return COMPONENT_NAME;
  }

  async execute(input: ReadFilesArgs, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const logger = getAgentLogger();
    const files = input.paths || [];
    if (!files.length) {
      return { output: 'Read files tool called without paths', uiProps: { files: [] } };
    }

    logger.debug(`[ReadFilesTool] Reading ${files.length} file(s): ${files.join(', ')}`);

    try {
      const buffers = await Promise.all(files.map((p) => this.#agentStorage.readFile(p)));

      const filesContentWithErrors = buffers.map((buf, index) => {
        const filePath = files[index]!;
        if (!buf) {
          return { filePath, error: `The file does not exist: ${filePath}` };
        }

        const content = buf.toString('utf-8');

        // Apply view range if specified
        const viewRange = normalizeViewRange(input.viewRanges?.[index]);
        if (!viewRange || (!viewRange.startLine && !viewRange.endLine)) {
          const cap = capFileContent(content);
          if (cap.capped) {
            return {
              filePath,
              content: cap.content,
              viewRange: { startLine: 1, endLine: cap.returnedLines, totalLines: cap.totalLines },
            };
          }
          return { filePath, content };
        }

        const lines = content.split('\n');
        const totalLines = lines.length;
        const start = Math.max(1, viewRange.startLine ?? 1);
        const endRaw = viewRange.endLine ?? totalLines;
        const end = endRaw === -1 ? totalLines : Math.min(totalLines, endRaw);
        const safeStart = Math.max(1, Math.min(start, totalLines === 0 ? 1 : totalLines));
        const safeEnd = Math.max(safeStart, Math.min(end, totalLines));

        const viewedContent = lines.slice(safeStart - 1, safeEnd).join('\n');

        return {
          filePath,
          content: viewedContent,
          viewRange: {
            startLine: safeStart,
            endLine: safeEnd,
            totalLines,
          },
        };
      });

      return {
        output: formatFilesOutput(filesContentWithErrors),
        uiProps: { files: filesContentWithErrors },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[ReadFilesTool] Error', { message });
      return {
        output: JSON.stringify({ error: message }),
        uiProps: { files: [], error: message },
      };
    }
  }
}
