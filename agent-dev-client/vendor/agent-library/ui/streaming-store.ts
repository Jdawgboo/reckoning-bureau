import type { AgentContent } from '../types/content.ts';
import type { AgentMessagePayload } from './types.ts';

/**
 * Minimal contract a messaging store must satisfy to be used by BuilderStreamSession
 * and AgentStreamController during reconnect and content restoration.
 *
 * The `configId` parameter is the agent config ID used by the builder (multi-agent).
 * Agent-side implementations use a fixed constant (e.g. 'agent') for this parameter.
 */
export interface IStreamingStore {
  processMessage(configId: string, payload: AgentMessagePayload): void;
  clearStreamingMessages(configId: string): void;
  restore(configId: string, items: AgentContent[]): void;
}
