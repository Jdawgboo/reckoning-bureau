import type { AgentContent } from '../types/content.ts';

/**
 * A batch of finalized UI content items emitted for persistence.
 *
 * Neutral by design: the agent emits these; it knows nothing about how (or
 * whether) they are stored. The platform wires a recorder onto the channel.
 * Items carry the stream's own ids, so committed UI history and replayed
 * deltas reconcile by identity on reload.
 */
export interface AgentContentEvent {
  items: AgentContent[];
  /**
   * Marks every item in this batch as partially streamed: the run ended
   * (abort/error) before the message finalized. Recorders persist the items
   * with `partial: true` so reloads can tell completed output from output
   * that was cut off mid-stream.
   */
  partial?: true;
}

export type AgentContentListener = (event: AgentContentEvent) => void;
