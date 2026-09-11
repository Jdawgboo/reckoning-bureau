export type AgentMessageTypeT = 'TXT' | 'Component' | 'Tool';
export interface IncomingMessageBasicI {
  messageId: string;
  contentId?: string;
  responseId?: string;
  previousVersion?: string;
}

export interface AgentMessagePayloadBasicI extends IncomingMessageBasicI {
  type: AgentMessageTypeT;
  content: any;
  index?: number | null;
}

export interface AgentTextMessagePayloadI extends AgentMessagePayloadBasicI {
  type: 'TXT';
  content: string;
}

export interface AgentToolPayloadI extends AgentMessagePayloadBasicI {
  type: 'Tool';
  tool: any;
  content: any;
}

export interface AgentComponentMessagePayloadI extends AgentMessagePayloadBasicI {
  type: 'Component';
  content: {
    componentName: string;
    componentCode: string;
    componentId: string;
    props: Record<string, any>;
  };
  tool?: any;
}

export type AgentMessagePayloadT =
  | AgentTextMessagePayloadI
  | AgentComponentMessagePayloadI
  | AgentToolPayloadI;

export type AgentMessageT = {
  componentName: string;
  type: AgentMessagePayloadT['type'];
  content: AgentMessagePayloadT['content'];
  id: string;
  role: MessageRoles.agent;
};

export enum MessageRoles {
  user = 'user',
  agent = 'assistant',
}

export interface UserTextMessagePayloadI {
  type: 'TXT';
  content: string;
}

export interface UserAudioMessagePayloadI {
  type: 'audio';
  content: {
    data: string;
    text?: string;
  };
}

export type UserMessagePayloadT = UserTextMessagePayloadI | UserAudioMessagePayloadI;

export type UserMessageT = {
  type: UserMessagePayloadT['type'];
  content: UserMessagePayloadT['content'];
  id: string;
  role: MessageRoles.user;
  files?: Attachment[];
};

import type { MemoryEntry } from '../../shared';
import type { Attachment, SessionType } from './bl/agent/agent-library';
import type { AgentRunPresentationCapability } from './bl/messaging/agent-run-presentation.ts';
export type { MemoryEntry } from '../../shared';

export interface SurfaceSnapshot {
  readonly isPopulated: boolean;
  readonly sections: ReadonlyArray<{
    readonly component: string;
    readonly props: Readonly<Record<string, unknown>>;
  }>;
}

export type SendMessageParamsT = {
  configId: string;
  message:
    | { type: 'TXT'; content: string }
    | { type: 'audio'; content: { data: string; text?: string } };
  instruction: string;
  metadata?: Record<string, unknown>;
  files?: Attachment[];
  renderedMessages?: PreviewMessageT[];
  memories?: MemoryEntry[];
  /** Client-authored rendering-contract note, injected into the prompt. */
  presentation?: string;
  /** Trusted runtime capability; never sourced from caller-authored metadata. */
  runPresentation?: AgentRunPresentationCapability;
  /**
   * Structural state captured before a render first touches its target screen.
   * Supplied only by a caller that has a live surface source (the WS session);
   * absent for HTTP, MCP, trigger and cron.
   */
  getSurfaceSnapshot?: (surfaceId: string) => SurfaceSnapshot;
  /** Trusted WebSocket attachment that originated this turn, when one exists. */
  localizationAttachmentId?: string;
  /** Session key for context storage - allows tools to access session info */
  sessionKey?: string;
  /** Session type for agent-library categorization. Defaults to 'web' in agent.runHandle(). */
  sessionType?: SessionType;
  /** Human-readable session name. */
  sessionName?: string;
};

export type UIMessageT = AgentMessageT | UserMessageT;

export type PreviewMessageT = UIMessageT;
