export type RunStatus = 'processing' | 'idle' | 'error' | 'aborted' | 'interrupted';

export interface CurrentRun {
  status: RunStatus;
  responseId: string;
  /** epoch ms when the run started */
  startedAt: number;
  /** Highest CONTENT# seq this run wrote; present once the content flush completed. */
  finalContentSeq?: number;
}

export interface ResolveRunStatusInput {
  currentRun: CurrentRun | null;
  /** executor liveness signal present & fresh (client-independent) */
  livenessFresh: boolean;
  /** epoch ms */
  now: number;
  /** grace after startedAt before a dead-liveness processing run is interrupted */
  graceMs?: number;
}

/**
 * Default start grace — a small safety margin covering the brief window between
 * `currentRun` becoming `processing` and the first `run-alive` write landing, so
 * a just-started run is not read as `interrupted` in that gap. It need NOT exceed
 * the liveness TTL: once running, the key is refreshed well within its TTL.
 */
export const DEFAULT_RUN_GRACE_MS = 15_000;

/**
 * The single source of the liveness rule. Pure — no I/O, no writes.
 *
 * A `processing` run whose executor liveness is gone, past the start grace, is
 * effectively `interrupted` ("we lost track of it"). Terminal statuses pass
 * through unchanged; a missing run is `idle`.
 */
export function resolveRunStatus(input: ResolveRunStatusInput): RunStatus {
  const { currentRun, livenessFresh, now, graceMs = DEFAULT_RUN_GRACE_MS } = input;
  if (!currentRun) {
    return 'idle';
  }
  if (currentRun.status !== 'processing') {
    return currentRun.status;
  }
  if (livenessFresh) {
    return 'processing';
  }
  if (now - currentRun.startedAt < graceMs) {
    return 'processing';
  }
  return 'interrupted';
}
