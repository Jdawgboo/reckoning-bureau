import type { ModelMessage } from '@ai-sdk/provider-utils';

/**
 * Neutral message-lifecycle event emitted by the agent core: a batch of new
 * messages (the injected system/user messages at turn 0, or a single step's
 * delta) plus the agent-only metadata a listener needs to record them. The
 * agent core does not know or care what a listener does with this — persistence
 * is one possible listener, not a concern of the core.
 */
export interface AgentMessages {
  messages: ModelMessage[];
  responseId: string | null;
  pendingToolCallIds: string[];
}

export type AgentMessagesListener = (event: AgentMessages) => void;
