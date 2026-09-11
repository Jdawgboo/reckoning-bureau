/**
 * Session types — shared between SessionManager, SessionQueue, and consumers.
 */

/** Session type — distinguishes session kinds for dashboard rendering. */
export type SessionType = 'web' | 'channel' | 'trigger' | 'schedule' | 'agent' | 'api';

/**
 * Session status — deterministic state machine.
 *
 * Transitions:
 *   idle → queued | processing
 *   queued → processing
 *   processing → idle | waiting | error
 *   waiting → processing | idle
 *   error → processing | idle
 */
export type SessionStatus = 'idle' | 'queued' | 'processing' | 'waiting' | 'error';

export type SessionLocaleSource = 'default' | 'navigator' | 'conversation' | 'explicit';

/** Durable presentation-language authority for one conversation session. */
export interface SessionPresentationLocale {
  messageLocale: string;
  formatLocale: string;
  source: SessionLocaleSource;
  revision: number;
}

/** Session metadata stored at /sessions/{sessionId}/summary */
export interface SessionSummary {
  sessionId: string;
  type: SessionType;
  status: SessionStatus;
  messageCount: number;
  /** Human-readable session name for dashboard display. Auto-set from context if not provided. */
  name?: string;
  /**
   * Where the current session name came from.
   * - undefined  → "pending": no finalized name; auto-derivation may run.
   * - 'auto'     → generated once by the platform; never auto-changed again.
   * - 'manual'   → set explicitly by the user; never auto-changed.
   */
  nameSource?: 'auto' | 'manual';
  /** Number of executions (primarily for trigger sessions). */
  executionCount?: number;
  /** Last execution result (primarily for trigger sessions). */
  lastExecution?: {
    status: 'success' | 'error';
    durationMs: number;
    summary?: string;
  };
  createdAt: string;
  lastActiveAt: string;
  /**
   * Engine (model id) the session last ran with. Stamped at run start via
   * {@link SessionManager.recordEngine}; dashboards use it to display/seed the
   * session's model.
   */
  lastEngine?: string;
  /** Owner-facing Builder model last admitted for this session. Independent from role engines. */
  lastBuilderModel?: string;
}

/**
 * A single conversation message stored as an individual DynamoDB record.
 * PK: AGENT#{agentId}, SK: MSG#{sessionId}#{seq}
 *
 * The `data` field holds the full AI SDK ModelMessage — the source of truth
 * for agent.run() continuity. Top-level `role` and `timestamp` are for
 * filtering/display without deserializing `data`.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  timestamp: string;
  /** Full AI SDK ModelMessage — the source of truth for conversation resumption. */
  data: unknown;
  /** Agent-run correlation when this message participates in a run. */
  responseId?: string;
}

/**
 * A durable session-scoped inbox event (`/sessions/<id>/inbox/<eventId>`).
 * Work that arrives while no consumer can take it: a dispatcher claims it and
 * starts a run (queue-while-busy, schedules), or a live run ingests it at a
 * step boundary (steering). Deleted on successful consumption.
 */
export interface SessionInboxEvent {
  /** Unique id — also the idempotency claim key for consumption. */
  id: string;
  kind: 'user-message' | 'schedule' | 'trigger';
  /** The instruction / message text. */
  text: string;
  /**
   * The user message's durable content id (`userMessageIdFor(requestId ?? id)`)
   * for `user-message` events — the same id the write-ahead CONTENT# record
   * carries. Lets the client correlate the pending queue entry to its
   * conversation group (it renders the queue in the strip and excludes those
   * groups from the inline thread by this id).
   */
  messageId?: string;
  origin: 'voice' | 'chat' | 'schedule' | 'trigger' | 'api' | 'eval';
  /** Ephemeral connection provenance retained only while an interactive send awaits admission. */
  sourceConnectionId?: string;
  createdAt: number;
  /**
   * Delivery lifecycle for queued user messages. `starting` means a dispatcher
   * has claimed the event and is publishing it as the active run, so queue
   * readers must no longer present it as pending. Missing means `pending` for
   * backward compatibility.
   */
  deliveryState?: 'pending' | 'starting';
  /**
   * How this event should reach the agent. `queue` (the default, and what a
   * missing value means) runs it as its own turn once the session is free.
   * `steer` asks the turn that is already running to take it at its next step
   * boundary, so the run keeps everything it has already done.
   *
   * Both live in the same inbox: only the consumer differs. A steer that the
   * running turn does not reach in time is drained as an ordinary run, which
   * is the intended fallback rather than an error path.
   *
   * Distinct from {@link deliveryState}, which is *where in its lifecycle* the
   * event is, not *how* it should be consumed.
   */
  dispatch?: 'queue' | 'steer';
  /** Set when consumption requires the user's presence (e.g. expired auth). */
  needsUser?: boolean;
  /**
   * Set once the queued user message has been journaled as a CONTENT# record
   * (at drain time). Idempotency guard: a drain that fails after persisting and
   * re-drains must not append a second record (the content store is append-only
   * and does not dedup by messageId).
   */
  userMessagePersisted?: boolean;
  /** Reference to the host-side authorization for unattended consumption (never credentials). */
  grantId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A finalized UI content item persisted to CONTENT# records.
 *
 * Stored at /sessions/{id}/content/{seq}. Append-only, never compacted.
 * What the client renders on reload — no streaming metadata, no intermediate
 * states, no reverse-engineering from LLM messages.
 */
export interface PersistedContentItem {
  /** Unique ID for this content item (matches the messageId used during streaming). */
  messageId: string;
  /** Agent-run correlation. May be present on that run's user echo and output; absent off-run. */
  responseId?: string;
  /** Who produced the content. */
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Content kind. */
  type: 'text' | 'component';
  /** Text content (for type: 'text'). */
  text?: string;
  /** Component name (for type: 'component'). */
  componentName?: string;
  /** Finalized component props (for type: 'component'). */
  props?: Record<string, unknown>;
  /** Plain-text projection materialized from the component contract. */
  fallbackText?: string;
  /** Markdown projection materialized from the component contract. */
  fallbackMarkdown?: string;
  /** Tool call ID that produced this component (for type: 'component'). */
  toolCallId?: string;
  /** Tool name (for type: 'component'). */
  toolName?: string;
  /** True when this content item represents a reasoning/thinking block. */
  isReasoning?: boolean;
  /** Hidden delivery/context content is persisted but not rendered in chat. */
  hidden?: boolean;
  /** Originating input or delivery channel, including `voice`. */
  channel?: string;
  /** Correlated voice-delivery evidence; absent for ordinary content. */
  voiceDelivery?: {
    kind: string;
    status: 'full' | 'partial' | 'unconfirmed';
    runId?: string;
    audioEndMs?: number;
  };
  /**
   * Present when the run ended before this message finalized (abort/error) —
   * the durable record of partially streamed output.
   */
  partial?: true;
  /** Base64-encoded audio bytes (for audio content items). */
  audioData?: string;
  /** File attachment metadata (for file content items). */
  files?: Array<{ name: string; type: string; url?: string }>;
}

/** Activity log entry stored at /sessions/{sessionId}/activity/{timestamp}-{seq} */
export interface ActivityEntry {
  action: string;
  summary: string;
  status: 'success' | 'error';
  durationMs?: number;
  error?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}
