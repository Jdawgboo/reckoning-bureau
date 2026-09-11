/**
 * Schedule event types for the inbox pipeline.
 *
 * A scheduled task is "just another inbox event" — the platform scheduler
 * writes to `/inbox/cron/{handler}/{eventId}`, the agent-side EventProcessor
 * routes to ScheduleDispatcher, which finds a registered handler or falls
 * back to LLM.
 */

import type { StateTree } from '../state/state-tree.ts';

// ---------------------------------------------------------------------------
// Schedule kinds — discriminated union for schedule format
// ---------------------------------------------------------------------------

/** Standard cron expression with optional IANA timezone. */
export interface CronKind {
  kind: 'cron';
  /** 5-field cron expression, e.g. "0 8 * * *" (parsed by croner). */
  expr: string;
  /** IANA timezone ("Europe/Berlin"). Defaults to UTC. */
  tz?: string;
}

/** Fixed interval in milliseconds. */
export interface EveryKind {
  kind: 'every';
  /** Interval in milliseconds, e.g. 60_000 for every minute. */
  everyMs: number;
}

/** One-time absolute time. */
export interface AtKind {
  kind: 'at';
  /** ISO 8601 UTC datetime, e.g. "2026-04-14T10:00:00Z". */
  at: string;
}

/** Schedule definition — discriminated union. */
export type ScheduleKind = CronKind | EveryKind | AtKind;

/** Returns true if the schedule is one-time (kind === 'at'). */
export function isOneTime(schedule: ScheduleKind): schedule is AtKind {
  return schedule.kind === 'at';
}

/** Returns true if the schedule is recurring (cron or every). */
export function isRecurring(schedule: ScheduleKind): schedule is CronKind | EveryKind {
  return schedule.kind !== 'at';
}

// ---------------------------------------------------------------------------
// Storage path — canonical location for schedule records in the state tree.
// ---------------------------------------------------------------------------

/** State-tree prefix under which all schedule records live. */
export const SCHEDULE_STATE_PREFIX = '/data/cron/';

/** Build the full state path for a schedule with the given taskId. */
export function scheduleStatePath(taskId: string): string {
  return `${SCHEDULE_STATE_PREFIX}${taskId}`;
}

/** Regex matching the schedule state path, capturing the taskId. */
export const SCHEDULE_STATE_PATH_RE = /^\/data\/cron\/([^/]+)$/;

// ---------------------------------------------------------------------------
// Schedule (agent-owned, stored at SCHEDULE_STATE_PREFIX + {taskId})
// ---------------------------------------------------------------------------

/** A schedule — the persistent record an agent or builder creates. */
export interface Schedule {
  // --- core (set by agent/builder) ---

  taskId: string;
  /** Human-readable name, max 128 chars. */
  name: string;
  /** Schedule definition — cron expression, fixed interval, or one-time. */
  schedule: ScheduleKind;
  /** Default true. Disabled schedules are ZREM'd from MemoryDB but kept in CRON#active. */
  enabled: boolean;
  /**
   * Registered handler name or "__default" for LLM fallback.
   * Validation: /^[a-zA-Z0-9_-]{1,64}$/ or "__default".
   */
  handler: string;
  params: Record<string, unknown>;
  /**
   * Who created this schedule — determines publish-lifecycle ownership:
   *  - 'builder': created via the builder tool (`ManageSchedulesTool`). Part of
   *    the agent definition. Replicated from preview → published on publish
   *    (stable taskId, recreated when preview changes, removed when preview
   *    removes it).
   *  - 'agent':  created at runtime via the agent's `createSchedule` tool
   *    during a user conversation. Owned by the end user. Publish NEVER
   *    touches agent-origin schedules.
   * Immutable once set. Missing value (pre-migration data) is treated as 'builder'.
   */
  origin: 'builder' | 'agent';

  /** Session binding (optional) — provides execution context and conversation history. */
  sessionId?: string;

  /** Broadcast targets (optional) — push results to external channels. */
  replyTo?: ScheduleReplyTarget[];

  // --- execution control (optional overrides) ---

  /** Agent-side best-effort turn limit, default ~50. */
  maxTurns?: number;
  /** Scheduler-side hard timeout in seconds, default 600 (10 min). */
  timeoutSeconds?: number;
  /** For one-time (at) tasks, max retry attempts. Default 3. */
  maxRetries?: number;
  /** UTC ISO datetime. Recurring: createdAt + 30d, one-time: fireTime + 7d. */
  expiresAt?: string;
  /**
   * Ephemeral session lifecycle after each run.
   * - 'delete': auto-delete ephemeral session after completion
   * - 'keep': preserve for audit trail / session search (default)
   * Ignored when sessionId is set (session-bound schedules).
   */
  sessionCleanup?: 'delete' | 'keep';

  // --- state tracking (platform-managed, set by Scheduler / StateService hook) ---

  /** Fly config ID for wake(). Set by StateService hook from agent context. */
  configId: string;
  /** UTC ISO datetime — computed by StateService hook / Scheduler. */
  nextRunAt: string;
  lastRunAt?: string;
  /** Set by dispatcher before firing, cleared by tracker on resolution. */
  runningAt?: string;
  /**
   * eventId the dispatcher fired with. Written alongside `runningAt` so the
   * scheduler can reconstruct the exact `/inbox/cron/{handler}/{eventId}` path
   * after a restart and correctly observe whether the agent processed it.
   */
  runningEventId?: string;
  /** Drives backoff. Default 0. */
  consecutiveErrors: number;
  lastRunStatus?: 'ok' | 'timeout' | 'error';
  /**
   * UTC ISO — set on the first credit-denied fire, cleared by the next
   * successful fire. Drives the credit-exhaustion auto-disable cutoff
   * (AGE-85/AGE-75). Scheduler-owned; never written from the state tree.
   */
  creditDeniedSince?: string;
  /**
   * Why the platform set `enabled: false` — 'failures' = repeated run
   * failures (autoDisableThreshold), 'credits' = owner out of credits past
   * the cutoff. Meaningful only while `enabled` is false; cleared on
   * re-enable.
   */
  disabledReason?: 'failures' | 'credits';
  lastDurationMs?: number;
  /** Set when execution succeeded but replyTo delivery failed. */
  lastDeliveryError?: string;
  createdAt: string;
  updatedAt: string;
}

/** A single broadcast target for schedule results. */
export interface ScheduleReplyTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Event (written to /inbox/cron/{handler}/{eventId} by the scheduler)
// ---------------------------------------------------------------------------

/** Schedule event written to /inbox/cron/{handler}/{eventId} by the platform scheduler. */
export interface ScheduleEvent {
  /** Unique execution ID (dedup key). */
  eventId: string;
  taskId: string;
  handler: string;
  params: Record<string, unknown>;
  /** UTC ISO datetime — when it was supposed to fire. */
  scheduledAt: string;
  sessionId?: string;
  replyTo?: ScheduleReplyTarget[];
  /**
   * Hours overdue, set by Scheduler when the task fires more than 1h late
   * (e.g., after scheduler downtime). Absent when fired on time.
   * Agent code can use this to adjust behavior — e.g., acknowledge the delay
   * to the user or skip stale work.
   */
  delayedByHours?: number;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/** Context passed to schedule handlers (mirrors TriggerContext). */
export interface ScheduleContext {
  /** The agent's state tree. */
  state: StateTree;
  /** Resolved sessionId. Undefined for sessionless schedule tasks. */
  sessionId?: string;
  /**
   * Invoke the LLM from within the handler. Uses the agent's configured model and instruction.
   *
   * @example
   * const { text } = await ctx.llm({ message: 'Summarize today\'s weather data.' });
   * await ctx.state.set('/data/weather/summary', { text });
   */
  llm: (options: ScheduleLlmOptions) => Promise<ScheduleLlmResult>;
}

/** Options for ctx.llm() inside a schedule handler. */
export interface ScheduleLlmOptions {
  /** The message to send to the LLM. */
  message: string;
}

/** Result from ctx.llm() inside a schedule handler. */
export interface ScheduleLlmResult {
  /** The LLM's text response. */
  text: string;
}

/** A function that handles a schedule event. Returns void — use ctx.llm() to invoke the LLM. */
export type ScheduleHandler = (event: ScheduleEvent, ctx: ScheduleContext) => void | Promise<void>;

/** Options for schedule handler registration. */
export interface ScheduleRegistrationOptions {
  /**
   * Override sessionId for this handler's executions. When omitted, uses
   * the schedule's sessionId (or ephemeral `cron-{taskId}-run-{eventId}`).
   *
   * The returned id must satisfy the session-id contract (see
   * `sessions/session-id.ts`) — notably, no `/`.
   *
   * @example
   * { sessionId: (event) => `cron-weather-${event.params.city}` }
   */
  sessionId?: (event: ScheduleEvent) => string;
}

/** A registered schedule handler: handler function + optional registration options. */
export type ScheduleRegistration = import('./event-router.ts').EventRegistration<
  ScheduleHandler,
  ScheduleRegistrationOptions
>;

/** Function that invokes the LLM, provided by the agent runtime to ScheduleDispatcher. */
export type ScheduleLlmFunction = (
  options: ScheduleLlmOptions,
  event: ScheduleEvent,
  sessionId?: string,
) => Promise<ScheduleLlmResult>;

/** Callback invoked when no handler is registered for a schedule event (LLM fallback). */
export type UnhandledScheduleCallback = (
  event: ScheduleEvent,
  /** Resolved sessionId. Undefined for sessionless schedule tasks. */
  sessionId?: string,
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Input types (for tools and builder API — excludes platform-managed fields)
// ---------------------------------------------------------------------------

/**
 * Input for creating a new schedule (agent tool or builder API).
 * Platform-managed fields (configId, nextRunAt, tracking counters) are
 * excluded — the tool sets defaults and the StateService hook augments
 * the CRON#active record with computed values.
 */
export interface CreateScheduleInput {
  name: string;
  /** Schedule definition — cron expression, fixed interval, or one-time. */
  schedule: ScheduleKind;
  /** Defaults to true. */
  enabled?: boolean;
  /** Registered handler name or "__default". Defaults to "__default". */
  handler?: string;
  params?: Record<string, unknown>;
  /** Explicit session ID. Takes priority over useCurrentSession. */
  sessionId?: string;
  /**
   * Bind the schedule to the current conversation session. Defaults to true.
   * When true (and sessionId is not set): auto-fills sessionId from the current session.
   * When false: schedule is sessionless (ephemeral session per execution).
   * Ignored when sessionId is explicitly provided.
   */
  useCurrentSession?: boolean;
  replyTo?: ScheduleReplyTarget[];
  maxTurns?: number;
  timeoutSeconds?: number;
  /** For one-time (at) tasks. Default 3. */
  maxRetries?: number;
  /** UTC ISO datetime. Auto-computed if omitted (recurring: +30d, one-time: fireTime +7d). */
  expiresAt?: string;
  /** Ephemeral session lifecycle: 'delete' (auto-cleanup) or 'keep' (default). */
  sessionCleanup?: 'delete' | 'keep';
}

/**
 * Input for updating an existing schedule.
 * Only mutable fields are accepted — handler, taskId, and all
 * platform-managed fields are immutable (delete and recreate instead).
 */
export interface UpdateScheduleInput {
  taskId: string;
  name?: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
  /** Full schedule replacement. Kind can change (e.g. cron → every). */
  schedule?: ScheduleKind;
  replyTo?: ScheduleReplyTarget[];
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Handler name pattern: alphanumeric + underscores + hyphens, 1-64 chars. */
export const HANDLER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Special handler name for LLM fallback. */
export const DEFAULT_HANDLER = '__default';

/** Validate a handler name. Returns true if valid (matches pattern or is __default). */
export function isValidHandlerName(name: string): boolean {
  return name === DEFAULT_HANDLER || HANDLER_NAME_PATTERN.test(name);
}

/** Max length for schedule name. */
export const MAX_SCHEDULE_NAME_LENGTH = 128;

/**
 * Upper bound on cron expression length. Real 5-field cron strings fit in a
 * few dozen characters even with complex lists/ranges; this is a defense
 * against an untrusted caller feeding croner a pathological input.
 */
export const MAX_CRON_EXPR_LENGTH = 512;

/**
 * Upper bound on IANA timezone string length. Real names (`America/Argentina/Buenos_Aires`)
 * top out around 40 chars; 128 leaves headroom without risking OOM in `Intl.DateTimeFormat`.
 */
export const MAX_TZ_NAME_LENGTH = 128;

/**
 * Upper bound on serialized size of the `params` object passed to a handler.
 * Params are persisted verbatim in the schedule record and replayed on every
 * fire, so oversized payloads multiply DDB write cost and state-tree size.
 */
export const MAX_PARAMS_JSON_BYTES = 10_000;

/**
 * Hard upper bound on how many schedules a single agent can create via
 * runtime tools. Protects against runaway LLM loops that would otherwise
 * spawn hundreds of schedules in a single conversation. Published / preview
 * environments may enforce tighter limits at their own boundaries (see doc
 * 19:625 — preview=3, published=10).
 */
export const MAX_AGENT_SCHEDULES = 10;

/**
 * Structural validation for a 5-field cron expression.
 *
 * Zero-dep check by design — the full parse happens on the platform server
 * via `croner` when the state hook computes `nextRunAt`. This is the
 * fast-reject for the common authoring mistakes: non-cron text, wrong
 * field count, out-of-range values, stray characters. A schedule that
 * passes here may still fail the server-side parse, but everything that
 * fails here is guaranteed malformed.
 *
 * Each field accepts the union of:
 *   - `*` or `?` (any / blank)
 *   - `N` integer (range-checked below)
 *   - `N-M` range (both endpoints range-checked)
 *   - step form: any atom followed by `/K` (e.g. `*` slash `N`, `N-M` slash `K`)
 *   - comma-separated list of any of the above
 *
 * Field ranges (inclusive):
 *   minute 0-59 · hour 0-23 · day-of-month 1-31 · month 1-12 · weekday 0-7
 */
export function isLikelyValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const fieldRanges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day-of-month
    [1, 12], // month
    [0, 7], // day-of-week (0 and 7 both = Sunday)
  ];
  const inRange = (n: number, [lo, hi]: [number, number]): boolean => n >= lo && n <= hi;
  const checkAtom = (atom: string, range: [number, number]): boolean => {
    if (atom === '*' || atom === '?') {
      return true;
    }
    // step form: base/step
    const stepMatch = atom.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (!Number.isFinite(step) || step <= 0) {
        return false;
      }
      return checkAtom(base, range);
    }
    // range form: N-M
    const rangeMatch = atom.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      return (
        Number.isFinite(lo) &&
        Number.isFinite(hi) &&
        lo <= hi &&
        inRange(lo, range) &&
        inRange(hi, range)
      );
    }
    // plain integer
    if (/^\d+$/.test(atom)) {
      return inRange(Number(atom), range);
    }
    return false;
  };
  return parts.every((field, i) =>
    field.split(',').every((atom) => checkAtom(atom, fieldRanges[i])),
  );
}

/**
 * Validate an IANA timezone using native `Intl.DateTimeFormat`. Throws if
 * the runtime doesn't support the timezone — we catch and return false.
 */
export function isValidIanaTimeZone(tz: string): boolean {
  if (!tz || tz.trim().length === 0) {
    return false;
  }
  try {
    // Will throw RangeError for any timezone the runtime doesn't recognize.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
