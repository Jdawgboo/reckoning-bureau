/**
 * Provider-native Anthropic Code Execution. The `toModelOutput` hook only
 * captures `file_id`s from the result and registers them in
 * `PendingFilesRegistry`; download + agent-storage write + DELETE happen
 * later in `UploadGeneratedFilesTool.execute()` (3-message ritual — see
 * code-executor-prompt).
 *
 * Split exists because `toModelOutput` runs in `toResponseMessages` AFTER
 * every same-step `execute()` resolves — so `code_execution + filesystem view`
 * in one turn would race the hook's upload. Moving upload into an explicit
 * tool puts it on the step boundary.
 *
 * The hook returns output UNCHANGED — `convertToAnthropicMessagesPrompt`
 * revalidates against `codeExecution_20260120OutputSchema` on every turn,
 * which requires `file_id: string` on every entry. Used inside the
 * `code-executor` subagent only.
 */
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { jsonSchema, type Tool as AiSdkTool } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import type { JSONValue } from '@ai-sdk/provider';
import { ToolModel, type ToolCall, type ToolInvocationContext } from '../../agent/agent-library.ts';
import type { PendingFilesRegistry } from './pending-files-registry.ts';

const TOOL_NAME = 'code_execution';

const paramsSchema = z.object({}).passthrough();
type Params = z.infer<typeof paramsSchema>;

export interface AnthropicCodeExecutionToolConfig {
  /**
   * Shared registry written by the hook and drained by `UploadGeneratedFilesTool`.
   * Same instance must be passed to both tools in one `createCodeExecutorSubagent`
   * call so they coordinate.
   */
  registry: PendingFilesRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AnthropicCodeExecutionTool extends ToolModel<Params> {
  readonly #tool: AiSdkTool<unknown, unknown>;
  readonly #registry: PendingFilesRegistry;

  constructor(config: AnthropicCodeExecutionToolConfig) {
    super({
      name: TOOL_NAME,
      // 'code_execution' (not 'function') so `tool-loop-agent.tools.ts:29`
      // skips the function-tool wrapping path and the provider-native tool
      // from `getAiSdkTool()` reaches the wire via `aiSdkToolset` instead.
      // Without this, Anthropic rejects the request with "skills can only
      // be used when a code execution tool is enabled".
      toolType: 'code_execution',
      description: 'Run Python in an Anthropic-managed sandbox. Provider executes server-side.',
      parametersSchema: paramsSchema,
      isStreaming: true,
    });
    this.#registry = config.registry;
    // Hook only captures file_ids; the explicit UploadGeneratedFilesTool does
    // the download + write + delete.
    const codeExecTool = anthropic.tools.codeExecution_20260120({
      toModelOutput: async ({ output }) => this.#registerFileIds(output),
    });

    // Relax over-strict @ai-sdk/anthropic input validation: it rejects code_execution calls
    // typed `programmatic-tool-call` unless they carry `code` (server-tool; Anthropic validates).
    (codeExecTool as { inputSchema: unknown }).inputSchema = jsonSchema({
      type: 'object',
      additionalProperties: true,
    });

    this.#tool = codeExecTool as AiSdkTool<unknown, unknown>;
  }

  override getAiSdkTool(): AiSdkTool<unknown, unknown> | null {
    return this.#tool;
  }

  async call(
    _toolCall: ToolCall<Params>,
    _ui: { append: (content: unknown) => void },
    _ctx: ToolInvocationContext<unknown>,
  ): Promise<unknown> {
    return null;
  }

  #registerFileIds(output: unknown): ToolResultOutput {
    if (isRecord(output)) {
      const type = output.type;
      const carriesFileIds =
        type === 'code_execution_result' ||
        type === 'encrypted_code_execution_result' ||
        type === 'bash_code_execution_result';

      if (carriesFileIds && Array.isArray(output.content)) {
        for (const entry of output.content) {
          if (!isRecord(entry)) {
            continue;
          }
          const fileId = entry.file_id;
          if (typeof fileId === 'string') {
            this.#registry.markPending(fileId);
          }
        }
      }
    }
    return { type: 'json', value: (output ?? null) as JSONValue };
  }
}
