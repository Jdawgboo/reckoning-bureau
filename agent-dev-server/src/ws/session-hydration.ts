/**
 * Single owner of durable-storage → in-memory `AgentSession` hydration.
 *
 * A dev-server restart drops every in-process piece of session state even
 * though the durable stores that back it are intact. Reconnecting with the
 * same session id must reconstruct that in-memory state, and this module is
 * where the FULL reconstruction contract lives — four steps, only two of
 * which are performed here:
 *
 * 1. CONTENT# load → replay-buffer priming (`hydrateSession`, this module).
 *    `loadContent` is fetched once and used both to warm `AgentSession`'s
 *    replay buffer (so a later `content.query` finds it already there) and
 *    as the PRE-EXISTING-KEY detector: an empty result means this
 *    sessionKey never persisted anything, i.e. a genuinely new session
 *    rather than a recreate. Buffer priming is skipped only while a LOCAL
 *    run is actually attached to the session (`session.hasActiveRun`, see
 *    `primeReplayBuffer`) — pushing would race that run's own live
 *    `pushContent` writes. The guard keys on `hasActiveRun`, never on
 *    `status`: `bindStateSummary`'s async pull can land a stale
 *    `'processing'` mid-hydration on a recreated session, and a
 *    status-string guard would then skip buffering until something reads
 *    the `status` getter and self-heals it — leaving `content.query`
 *    returning `[]` and the welcome turn firing on top of existing history.
 * 2. Replay stored surface payloads from the CONTENT# array already loaded
 *    in step 1 (`hydrateSession`, this module). Each Surface component
 *    record carries `uiProps.surfaceReplay` — the same composed A2UI
 *    events (`createSurface` + `updateComponents`) the Surface tool emitted
 *    live (`render-surface.tool.ts`) — so restoring a screen is a direct
 *    replay of stored events via `recordA2uiEvent`, the SAME function the
 *    live agui stream consumer uses (`consume-agui-stream.ts`). No WAL
 *    read, no contract lookup, no surface-specific rebuild: the payload is
 *    already exactly what the client needs to see again. Accepted limit:
 *    a session whose renders predate this change carries no
 *    `surfaceReplay` payload in its CONTENT# records, so it restores
 *    text-only — the screens themselves are not recoverable for those
 *    older sessions.
 * 3. `bindStateSummary` initial pull (status) — a state-tree NODE BIND, not
 *    a storage load, so it stays in `WsSessionManager#createSession`
 *    alongside step 4. A recreated session starts with the durable status
 *    instead of the `AgentSession` field default.
 * 4. `bindStateUiState` initial pull (uiState data model) — same node-bind
 *    treatment as step 3, also in `WsSessionManager#createSession`.
 *
 * Step 1 is best-effort: I/O errors are swallowed (this warms a session, it
 * does not answer a request) and reported via `onError` for telemetry. Step
 * 2 is a synchronous pass over already-loaded data — no I/O, nothing to
 * swallow.
 *
 * Callers: `WsSessionManager#createSession` fires `hydrateSession`
 * fire-and-forget (off the connect path — see its `#priming`/`whenPrimed`
 * doc) for every (re)created session with a bound `agentSessionManager`.
 * `content.query` and stage resync no longer call anything in this module
 * directly — they only `await whenPrimed()` then read session state, so
 * hydration's existence and internals stay opaque to them.
 */
import {
  ContentType,
  aguiEvent,
  type AgentContent,
  type AguiEvent,
} from '../bl/agent/agent-library.ts';
import { isRecord } from '../util/type-guards.ts';
import { A2UI_EVENT_NAMES } from '../../vendor/agentplace-a2ui/event-names.ts';

const SURFACE_COMPONENT_NAME = 'Surface';

/** One entry of a Surface record's `uiProps.surfaceReplay` — mirrors
 *  `SurfaceEvent` in `render-surface.helpers.ts` without importing it: this
 *  module only ever reads the value back out of durable storage, it never
 *  builds one. */
interface SurfaceReplayEvent {
  name: string;
  value: unknown;
}

/** Minimal `AgentSession` surface hydration depends on. */
export interface HydrationSession {
  sessionKey: string;
  /** True only while a run driven by THIS process is attached to the
   *  session (`AgentSession#hasActiveRun`) — the priming guard's signal,
   *  never `status` (see module JSDoc). */
  hasActiveRun: boolean;
  pushContent(content: AgentContent): void;
  recordA2uiEvent(event: AguiEvent, responseId?: string): void;
}

export interface HydrateSessionDeps {
  loadContent(sessionId: string): Promise<AgentContent[]>;
  onError?(error: unknown): void;
}

/**
 * Hydrates `session` from durable storage. See the module JSDoc for the
 * full four-step contract — this function owns steps 1-2.
 */
export async function hydrateSession(
  session: HydrationSession,
  deps: HydrateSessionDeps,
): Promise<void> {
  const contentItems = await loadContentItems(session, deps);
  primeReplayBuffer(session, contentItems);
  for (const content of contentItems) {
  }
  replayStoredSurfaces(session, contentItems);
}

async function loadContentItems(
  session: HydrationSession,
  deps: HydrateSessionDeps,
): Promise<AgentContent[]> {
  try {
    return await deps.loadContent(session.sessionKey);
  } catch (error) {
    deps.onError?.(error);
    return [];
  }
}

/**
 * Pushes durable content into the session's replay buffer so a later
 * `content.query` finds it already there. Skipped while `hasActiveRun` is
 * true — pushing would race that LOCAL run's own live `pushContent` writes
 * and produce duplicates, so a session with a live run is simply left
 * unbuffered rather than force-fed through a racy path. Deliberately NOT
 * keyed on `status`: a recreated session's durable status can read
 * `'processing'` from stale state (see module JSDoc) with no run actually
 * attached, and skipping buffering in that case would starve
 * `content.query` for no reason.
 */
function primeReplayBuffer(session: HydrationSession, contentItems: readonly AgentContent[]): void {
  if (contentItems.length === 0 || session.hasActiveRun) {
    return;
  }
  for (const content of contentItems) {
    session.pushContent(content);
  }
}

/**
 * Replays each surface's stored `uiProps.surfaceReplay` payload back onto
 * the session's live A2UI event stream (`recordA2uiEvent`) so
 * `buildResyncFrames()` finds them on the next connect. Only the LAST
 * record per `surfaceId` is replayed — `Render*` tools replace a surface
 * wholesale, never patch, so an earlier render of the same surface is
 * stale by definition. Records with no (or malformed) `surfaceReplay` are
 * skipped rather than thrown on — see the module JSDoc's accepted limit.
 *
 * A record must be SELF-SUFFICIENT: it has to open with `createSurface`, or
 * replaying it alone hits the store's unknown-surface branch, is dropped, and
 * the screen restores as **nothing**. That holds by construction today —
 * `buildSurfaceEvents` always emits the pair — so the check below guards a
 * future incremental producer rather than anything shipping. An incomplete
 * record is skipped (and warned about) instead of being allowed to become the
 * surface's last word, which would blank the screen silently.
 */
function replayStoredSurfaces(
  session: HydrationSession,
  contentItems: readonly AgentContent[],
): void {
  const lastBySurfaceId = new Map<
    string,
    { events: SurfaceReplayEvent[]; responseId: string | undefined }
  >();
  for (const item of contentItems) {
    if (item.type !== ContentType.Component || item.componentName !== SURFACE_COMPONENT_NAME) {
      continue;
    }
    const surfaceId = readString(item.props, 'surfaceId');
    const events = readReplayEvents(item.props['surfaceReplay']);
    if (!surfaceId || events.length === 0) {
      continue;
    }
    if (!isSelfSufficient(events)) {
      console.warn(
        '[session-hydration] skipping a surface record with no createSurface frame',
        surfaceId,
      );
      continue;
    }
    lastBySurfaceId.set(surfaceId, { events, responseId: item.responseId });
  }
  for (const { events, responseId } of lastBySurfaceId.values()) {
    for (const event of events) {
      session.recordA2uiEvent(aguiEvent.custom(event.name, event.value), responseId);
    }
  }
}

/** A stored record can only rebuild a screen on its own if it creates the
 *  surface first. */
function isSelfSufficient(events: readonly SurfaceReplayEvent[]): boolean {
  return events.some((event) => event.name === A2UI_EVENT_NAMES.createSurface);
}

function readString(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' && value ? value : undefined;
}

/** Narrows `unknown` (a CONTENT# record's `uiProps.surfaceReplay` value,
 *  possibly having crossed a JSON round trip) to `SurfaceReplayEvent[]`.
 *  Returns `[]` on anything that doesn't fully match the shape — a missing
 *  field on one entry invalidates the whole payload rather than replaying
 *  a partial surface. */
function readReplayEvents(value: unknown): SurfaceReplayEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: SurfaceReplayEvent[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      return [];
    }
    events.push({ name: entry['name'], value: entry['value'] });
  }
  return events;
}
