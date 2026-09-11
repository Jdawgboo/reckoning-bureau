/**
 * Shared in-memory map of Anthropic Files API `file_id`s produced in a
 * single `code-executor` subagent run. Written by the
 * `AnthropicCodeExecutionTool` hook, drained by `UploadGeneratedFilesTool`.
 * One instance per `createCodeExecutorSubagent` — both tools share the
 * reference via their constructors.
 */
export type PendingFileStatus = 'pending' | 'processed';

export class PendingFilesRegistry {
  readonly #entries = new Map<string, PendingFileStatus>();

  markPending(fileId: string): void {
    // Don't downgrade an already-processed entry back to pending if the same
    // file_id somehow arrives again (Anthropic's sandbox is persistent across
    // calls inside one subagent run, so a result can in theory re-emit ids).
    if (this.#entries.get(fileId) === 'processed') return;
    this.#entries.set(fileId, 'pending');
  }

  markProcessed(fileId: string): void {
    this.#entries.set(fileId, 'processed');
  }

  listPending(): string[] {
    const ids: string[] = [];
    for (const [id, status] of this.#entries) {
      if (status === 'pending') ids.push(id);
    }
    return ids;
  }

  has(fileId: string): boolean {
    return this.#entries.has(fileId);
  }
}
