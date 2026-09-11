/**
 * Reads the agent's collection declarations for the tool registry, which is
 * rebuilt once per turn on every run path.
 *
 * Holds the last successful answer for the process. That is NOT a freshness
 * cache — a successful read always replaces it, and the platform already caches
 * declarations behind the RPC. It exists because the alternative on a transient
 * failure is worse than a stale answer: an empty tool description puts the agent
 * back to guessing required fields mid-conversation, and swapping the
 * description out and back churns the whole cached prompt prefix twice.
 *
 * One VM process serves exactly one `{configId, env}` partition, so the memo
 * cannot carry one agent's collections into another's.
 */

import type { CollectionDeclaration } from '../../../vendor/agent-library/records/types.ts';

/** The declaration read this resolver needs — satisfied by `RecordsClient`. */
export interface DeclarationsReader {
  listDeclarations(): Promise<CollectionDeclaration[]>;
}

let lastDeclarations: CollectionDeclaration[] = [];

export async function resolveRecordsDeclarations(
  reader: DeclarationsReader,
): Promise<CollectionDeclaration[]> {
  try {
    lastDeclarations = await reader.listDeclarations();
  } catch (error) {
    console.warn('[RecordsDeclarations] read failed, reusing the last known set:', error);
  }
  return lastDeclarations;
}
