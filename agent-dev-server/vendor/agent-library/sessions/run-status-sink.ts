/**
 * Seam by which the agent loop reports run-lifecycle transitions to a host that
 * wants to OWN the durable `currentRun` write (the builder's RunRegistry).
 *
 * The default `SessionManager` behavior (write `currentRun` directly) is used
 * when no sink is injected, so deployed agents are unaffected. The builder
 * injects a sink that routes to its server-side RunRegistry.
 *
 * Every event carries the emitting SessionManager's `agentId` (its
 * construction-time scope), so hosts receive fully-scoped events and never
 * have to reverse-map sessionId → agentId.
 *
 * agent-library has no knowledge of RunRegistry, leases, claims, or instances —
 * it only emits run-lifecycle events against this interface.
 */
export interface RunStatusSink {
  /** The run has begun processing. */
  onRunProcessing(run: {
    agentId: string;
    sessionId: string;
    responseId: string;
    startedAt: number;
  }): Promise<void>;
  /** The run reached a terminal status. `idle` = completed, `error` = failed. */
  onRunTerminal(run: {
    agentId: string;
    sessionId: string;
    responseId: string;
    status: 'idle' | 'error';
  }): Promise<void>;
  /** The run's content flush completed; persist the completion cursor onto the current-run record. */
  onRunContentFlushed(event: {
    agentId: string;
    sessionId: string;
    responseId: string;
    finalContentSeq: number;
  }): Promise<void> | void;
}
