import type { AgentContent } from '@/lib/agent-library';
import type {
  MemoryEntry,
  StoredContent as StoredContentGeneric,
  AgentStreamContent as AgentStreamContentGeneric,
} from '../../../../../shared';

export type {
  SessionInfo,
  FinishSignalContent,
  ErrorSignalContent,
  MemoryEntry,
  LocaleHintParams,
  LocaleProposeParams,
  LocaleActivatedParams,
  LocaleCommittedParams,
  LocaleBundleReadyParams,
  LocaleSourceFallbackParams,
} from '../../../../../shared';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface WebSocketClientOptions {
  baseUrl?: string;
  getAgentSessionId?: () => string | null;
  onSessionJoined?: (sessionKey: string) => void;
}

export interface SendMessageOptions {
  files?: unknown[];
  instruction?: string;
  memoryBank?: MemoryEntry[];
  metadata?: Record<string, unknown>;
  /** When true, the user message is stored but not rendered in chat UI */
  hidden?: boolean;
  /** Client-authored rendering-contract note injected into the agent's prompt. */
  presentation?: string;
}

export type StoredContent = StoredContentGeneric<AgentContent>;
export type AgentStreamContent = AgentStreamContentGeneric<AgentContent>;

export interface ContentQueryResult {
  type: 'content.query.ack';
  items: StoredContent[];
  snapshot: AgentContent | null;
  snapshotEventSeq: number | null;
  streamStatus: 'complete' | 'in_progress';
  activeRequestId: string | null;
}
