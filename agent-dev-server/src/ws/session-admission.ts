/**
 * Who may attach to a session, and what happens when the agent is holding more
 * sessions than it should.
 *
 * A session id is not a secret. It travels in `?agent_session_id=` on page and
 * embed URLs, so it ends up in shared links, browser history and screenshots.
 * Sessions are therefore bound to the visitor who started them: naming a session
 * id is how you *address* a conversation, not how you prove you may read it.
 *
 * The rules live here rather than inline in `WsSessionManager` because both
 * WebSocket entry points — the main `/ws` socket and the voice socket — reach
 * the manager, and because the identity rule has one limit worth stating in a
 * single place (below).
 *
 * ## What identity means here
 *
 * `extractSessionIdentity` reads the `x-user-id` header. The platform sets that
 * header itself after authenticating the visitor, and removes any copy the
 * caller tried to send, so its value can be trusted. Two fallbacks apply when
 * the header is absent:
 *
 * - a preview runtime carries `ADMIN_USER_ID`, the agent's owner — sound,
 *   because only the owner can reach a preview;
 * - a published runtime carries neither, so every visitor to an agent that does
 *   not require sign-in is `'anonymous'`.
 *
 * That second case is the limit: identity binding cannot tell two anonymous
 * visitors apart, so on an agent open to everyone a shared session id still
 * opens the conversation it names. Separating those visitors would need a
 * session id paired with a per-visitor secret. What binding does cover is the
 * case that matters for signed-in agents: one visitor cannot resume another's
 * conversation.
 */
import BaseError from '../errors/base-error.ts';

/**
 * The identity used when no `x-user-id` header is present and the runtime sets
 * no `ADMIN_USER_ID` — a visitor to an agent that does not require sign-in.
 * Exported so callers can reason about the limit in the module header instead of
 * re-deriving the sentinel.
 */
export const ANONYMOUS_USER_ID = 'anonymous';

/**
 * Identities the agent stamps on its OWN scheduled runs, never on a request.
 *
 * A fired schedule or trigger attaches to a session so its output reaches any
 * browser clients currently connected, and that session usually belongs to a
 * signed-in visitor. A strict identity match would refuse every one of those
 * broadcasts, and the scheduling path does not surface such a failure, so
 * schedules would simply stop appearing. The reverse direction matters too: a
 * session a schedule created has to stay readable by the person who wants to
 * open it.
 *
 * Safe because these values cannot arrive from outside. Every request-derived
 * identity comes from `x-user-id`, which the platform overwrites with an
 * authenticated account id, and no route passes these strings.
 *
 * Deliberately NOT extended to `'mcp-user'`, `'api-user'` or `'import-user'`:
 * those label external callers of the MCP and HTTP routes.
 */
export const UNATTENDED_PRINCIPALS: readonly string[] = ['trigger', 'cron'];

/**
 * The ways an entry point spells "this caller has no authenticated identity".
 * The sockets say `'anonymous'`, the message route says `'api-user'`, the
 * session-import route says `'import-user'`. All three mean the same thing — no
 * `x-user-id` header — so they count as one principal. Treating them as three
 * would refuse an unauthenticated caller that posts a message over HTTP and then
 * resumes the same session over the socket, which is a supported flow.
 *
 * `'mcp-user'` is deliberately absent: MCP clients authenticate, so folding them
 * in would let an MCP client attach to a browser visitor's session.
 */
const UNAUTHENTICATED_PRINCIPALS: readonly string[] = [
  ANONYMOUS_USER_ID,
  'api-user',
  'import-user',
];

/**
 * Default ceiling on live sessions per runtime. Each session holds a replay
 * buffer and two state subscriptions, and the session id is supplied by the
 * caller, so without a ceiling a caller can allocate them indefinitely.
 *
 * Generous on purpose: a session with a connected client is never evicted, so
 * this bounds retained IDLE sessions, not concurrent visitors. An evicted
 * session rebuilds from durable storage on the next connect
 * (`session-hydration.ts`), which is what makes eviction the cheap response and
 * refusal the last resort.
 */
export const DEFAULT_MAX_SESSIONS = 500;

/** A caller named a session that belongs to a different visitor. */
export class SessionAccessDeniedError extends BaseError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SessionAccessDeniedError.prototype);
  }
}

/** The runtime is at its session ceiling and nothing could be evicted. */
export class SessionCapacityError extends BaseError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SessionCapacityError.prototype);
  }
}

/** True for an identity only the agent's own scheduled runs can carry. */
export function isUnattendedPrincipal(userId: string): boolean {
  return UNATTENDED_PRINCIPALS.includes(userId);
}

/** True for any of the sentinels meaning "no `x-user-id` was present". */
function isUnauthenticated(userId: string): boolean {
  return UNAUTHENTICATED_PRINCIPALS.includes(userId);
}

/**
 * Refuses a caller whose identity differs from the one the session was created
 * for. Applied on every path that returns an existing session — live,
 * expired-but-still-recorded, and in-flight — because the stored conversation
 * behind a session id is rehydrated into whichever session object ends up
 * holding it.
 *
 * A plain equality check on the platform-supplied id: it is the same string on
 * both sides, so there is nothing to normalize. Anything that is not an exact
 * match is a different visitor — except an unattended run, which is authorized
 * by where it came from rather than by matching a visitor
 * ({@link UNATTENDED_PRINCIPALS}).
 */
export function assertMayJoinSession(params: {
  sessionKey: string;
  sessionUserId: string;
  connectingUserId: string;
}): void {
  const { sessionKey, sessionUserId, connectingUserId } = params;
  if (sessionUserId === connectingUserId) {
    return;
  }
  if (isUnattendedPrincipal(sessionUserId) || isUnattendedPrincipal(connectingUserId)) {
    return;
  }
  if (isUnauthenticated(sessionUserId) && isUnauthenticated(connectingUserId)) {
    return;
  }
  throw new SessionAccessDeniedError(
    `Session ${sessionKey} belongs to a different user than the one connecting`,
  );
}

/**
 * Maps a refused connection onto a WebSocket close frame, or `null` for anything
 * else (which stays an internal error at the call site).
 *
 * Both sockets otherwise close with 1011 "Internal error", which is wrong twice
 * over: a refusal is not a server fault, and 1011 tells a client nothing about
 * whether retrying could ever work. `reason` stays short because the close frame
 * caps it at 123 bytes.
 */
export function describeAdmissionFailure(error: unknown): { code: number; reason: string } | null {
  if (error instanceof SessionAccessDeniedError) {
    return { code: 1008, reason: 'session belongs to another user' };
  }
  if (error instanceof SessionCapacityError) {
    return { code: 1013, reason: 'agent is at session capacity' };
  }
  return null;
}

/** The fields {@link selectEvictableSession} needs from a live session. */
export interface SessionEvictionCandidate {
  sessionKey: string;
  clientCount: number;
  status: string;
  remainingTtlMs: number;
}

/**
 * Picks the session to drop so a new one can be admitted, or `null` when none
 * may be.
 *
 * Only sessions with no connected client and no run in flight are eligible —
 * evicting either would strand a visitor or orphan a turn mid-stream. Among
 * those, the one closest to expiring goes first: `remainingTtlMs` is derived from
 * the session's last activity, so this is least-recently-used by another name.
 */
export function selectEvictableSession(
  candidates: readonly SessionEvictionCandidate[],
): string | null {
  let evictable: SessionEvictionCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.clientCount > 0 || candidate.status === 'processing') {
      continue;
    }
    if (!evictable || candidate.remainingTtlMs < evictable.remainingTtlMs) {
      evictable = candidate;
    }
  }
  return evictable?.sessionKey ?? null;
}
