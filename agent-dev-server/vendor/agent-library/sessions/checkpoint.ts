import type { ConversationMessage } from './types.ts';
import { isRecord } from '../util/type-guards.ts';

export const CHECKPOINT_TYPE = 'compaction-checkpoint';

export interface CheckpointData {
  type: typeof CHECKPOINT_TYPE;
  /**
   * @deprecated Always written as `0`. The seq is the DDB sort key, assigned at
   * write time, so the middleware that decides the cut has no seq to record.
   * Use {@link CheckpointData.firstKeptMid}.
   */
  firstKeptSeq: number;
  /** Assigned id of the first message KEPT — where a render resumes. */
  firstKeptMid?: string | null;
  summary: string | null;
  storedResults: string[];
  metadata: Record<string, unknown>;
}

export function isCheckpointMessage(msg: ConversationMessage): boolean {
  const data = msg.data;
  return isRecord(data) && data['type'] === CHECKPOINT_TYPE;
}

export function createCheckpointMessage(
  firstKeptSeq: number,
  summary: string | null,
  storedResults: string[],
  metadata: Record<string, unknown>,
  firstKeptMid: string | null = null,
): ConversationMessage {
  const data: CheckpointData = {
    type: CHECKPOINT_TYPE,
    firstKeptSeq,
    firstKeptMid,
    summary,
    storedResults,
    metadata,
  };
  return { role: 'system', timestamp: new Date().toISOString(), data };
}

/**
 * The checkpoint's payload, or null when the message is not a checkpoint.
 *
 * The single reader of the record's shape — so `CheckpointData` is enforced at
 * both ends rather than being a comment.
 */
export function readCheckpointData(msg: ConversationMessage): CheckpointData | null {
  const data = msg.data;
  if (!isRecord(data) || data['type'] !== CHECKPOINT_TYPE) return null;
  return {
    type: CHECKPOINT_TYPE,
    firstKeptSeq: typeof data['firstKeptSeq'] === 'number' ? data['firstKeptSeq'] : 0,
    firstKeptMid: typeof data['firstKeptMid'] === 'string' ? data['firstKeptMid'] : null,
    summary: typeof data['summary'] === 'string' ? data['summary'] : null,
    storedResults: Array.isArray(data['storedResults'])
      ? data['storedResults'].filter((p): p is string => typeof p === 'string')
      : [],
    metadata: isRecord(data['metadata']) ? data['metadata'] : {},
  };
}
