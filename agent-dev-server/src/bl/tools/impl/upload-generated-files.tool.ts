/**
 * Companion to `AnthropicCodeExecutionTool`. Drains the shared
 * `PendingFilesRegistry`: fetches each pending file from the Anthropic Files
 * API via the platform gateway, writes the bytes into agent storage, fire-
 * and-forget DELETEs at Anthropic, then marks the id processed. Zero
 * parameters so the model can't hallucinate `file_id`s. Used inside the
 * `code-executor` subagent only.
 */
import { z } from 'zod';
import {
  ToolModel,
  type AgentState,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';
import type { AgentStorage } from '../../../../vendor/agent-library/storage/agent-storage.ts';
import { getSessionKey, type DevServerAppState } from '../../agent/agent-state.ts';
import type { PendingFilesRegistry } from './pending-files-registry.ts';

const TOOL_NAME = 'upload_generated_files';
const FILES_API_BETA = 'files-api-2025-04-14';

const paramsSchema = z.object({});
type Input = z.infer<typeof paramsSchema>;

export interface UploadGeneratedFilesToolConfig {
  /** Shared with `AnthropicCodeExecutionTool` — hook fills, this tool drains. */
  registry: PendingFilesRegistry;
  storageFactory: {
    getStorage(secretFolder?: string): Pick<AgentStorage, 'writeFile'>;
  };
  /** Must already include the `/api/gateway` prefix. */
  gatewayBaseUrl: string;
  accessKey: string;
}

interface FilesApiMetadata {
  filename?: string;
  mime_type?: string;
}

type FileResult =
  | { kind: 'ok'; fileId: string; filename: string; mediaType: string }
  | { kind: 'error'; fileId: string; reason: string };

export class UploadGeneratedFilesTool extends ToolModel<Input> {
  readonly #config: UploadGeneratedFilesToolConfig;

  constructor(config: UploadGeneratedFilesToolConfig) {
    super({
      name: TOOL_NAME,
      toolType: 'function',
      description:
        'Move files just produced by `code_execution` into agent storage. Zero args. ' +
        '**Call alone in the message AFTER `code_execution` — never in parallel with it.** ' +
        'Returns `<filename> (<mediaType>)` lines on success. If you get `No new files to upload` ' +
        'right after a successful `code_execution`, this was emitted in parallel — retry alone ' +
        'in the next message.',
      parametersSchema: paramsSchema,
      isStreaming: false,
    });
    this.#config = config;
  }

  async execute(_input: Input, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    if (ctx.abortSignal?.aborted) return { output: 'Canceled.' };

    const pending = this.#config.registry.listPending();
    if (pending.length === 0) {
      return {
        output:
          'No new files to upload — retry this tool alone in your NEXT message. ' +
          'Most likely the previous `code_execution` and this call were in the same assistant ' +
          "message; the file ids weren't registered yet when this ran. On retry the runtime will " +
          'have them. (If the previous `code_execution` genuinely produced no files, skip this tool.)',
      };
    }

    // Session-scoped — files land in `private/<secretFolder>/`. Matches the
    // pattern in `filesystem.tool.ts`.
    const agentState = ctx.runner.state as AgentState<unknown, DevServerAppState>;
    const secretFolder = getSessionKey(agentState);

    const results = await Promise.all(
      pending.map((id) => this.#processFileId(id, ctx.abortSignal, secretFolder)),
    );

    if (ctx.abortSignal?.aborted) return { output: 'Canceled.' };

    // Drain successes AND failures — the registry survives across subagent
    // invocations, so leaving failed entries pending would let stale ids
    // from a prior task leak into the next call's storage.
    for (const id of pending) {
      this.#config.registry.markProcessed(id);
    }

    const successes = results.filter(
      (r): r is Extract<FileResult, { kind: 'ok' }> => r.kind === 'ok',
    );
    const failures = results.filter(
      (r): r is Extract<FileResult, { kind: 'error' }> => r.kind === 'error',
    );

    return { output: this.#formatOutput(pending.length, successes, failures) };
  }

  async #processFileId(
    fileId: string,
    signal: AbortSignal | undefined,
    secretFolder: string | undefined,
  ): Promise<FileResult> {
    const idEnc = encodeURIComponent(fileId);
    const metaUrl = `${this.#config.gatewayBaseUrl}/anthropic/v1/files/${idEnc}`;
    const contentUrl = `${this.#config.gatewayBaseUrl}/anthropic/v1/files/${idEnc}/content`;
    const headers = {
      'X-Access-Key': this.#config.accessKey,
      'anthropic-beta': FILES_API_BETA,
    };

    try {
      const metaResp = await fetch(metaUrl, { headers, signal });
      if (!metaResp.ok) {
        return {
          kind: 'error',
          fileId,
          reason: `metadata HTTP ${metaResp.status}`,
        };
      }
      const meta = (await metaResp.json()) as FilesApiMetadata;
      const filename = meta.filename ?? `${fileId}.bin`;
      const mediaType = meta.mime_type ?? 'application/octet-stream';

      if (signal?.aborted) return { kind: 'error', fileId, reason: 'canceled' };

      const downloadResp = await fetch(contentUrl, { headers, signal });
      if (!downloadResp.ok) {
        return {
          kind: 'error',
          fileId,
          reason: `download HTTP ${downloadResp.status}`,
        };
      }
      const buffer = Buffer.from(await downloadResp.arrayBuffer());

      const storage = this.#config.storageFactory.getStorage(secretFolder);
      await storage.writeFile(filename, buffer);

      // Best-effort cleanup at Anthropic — not awaited.
      void fetch(metaUrl, { method: 'DELETE', headers })
        .then((r) => {
          if (!r.ok) {
            console.warn('[UploadGeneratedFiles] delete returned status', r.status);
          }
        })
        .catch((err) => {
          console.warn('[UploadGeneratedFiles] cleanup delete failed:', err);
        });

      return { kind: 'ok', fileId, filename, mediaType };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'error', fileId, reason: msg };
    }
  }

  #formatOutput(
    total: number,
    successes: Array<Extract<FileResult, { kind: 'ok' }>>,
    failures: Array<Extract<FileResult, { kind: 'error' }>>,
  ): string {
    const lines: string[] = [];
    lines.push(`Saved ${successes.length}/${total} file(s) to agent storage.`);
    if (successes.length > 0) {
      lines.push('');
      for (const s of successes) {
        lines.push(`- ${s.filename} (${s.mediaType})`);
      }
    }
    if (failures.length > 0) {
      lines.push('');
      lines.push('Failed:');
      for (const f of failures) {
        lines.push(`- file_id ${f.fileId}: ${f.reason}`);
      }
    }
    return lines.join('\n');
  }
}
