// =============================================================================
// Wire protocol: server → client notifications
// =============================================================================

export interface StreamEventNotification {
  type: 'stream';
  responseId: string;
  eventSeq: number;
  content: unknown;
}

export interface StreamEndNotification {
  type: 'streamEnd';
  responseId: string;
}

export interface StreamErrorNotification {
  type: 'streamError';
  responseId: string;
  error: string;
}

export type StreamNotification =
  | StreamEventNotification
  | StreamEndNotification
  | StreamErrorNotification;

// =============================================================================
// Wire protocol: client → server actions
// =============================================================================

export interface SubscribeAction {
  type: 'subscribe';
  responseId: string;
}

export interface ResumeAction {
  type: 'resume';
  responseId: string;
  lastEventSeq?: number;
}

export interface AbortAction {
  type: 'abort';
  responseId?: string;
}

export type StreamAction = SubscribeAction | ResumeAction | AbortAction;

// =============================================================================
// Wire protocol: server → client catch-up response
// =============================================================================

export interface CatchUpResult {
  type: 'resumed' | 'error';
  responseId: string;
  lastEventSeq?: number;
  status?: string;
  totalEvents?: number;
  replayedEvents?: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}
