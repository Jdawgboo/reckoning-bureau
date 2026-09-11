/**
 * Which WebSocket close codes end the connection for good, and what to tell the
 * visitor when one does.
 *
 * The transport adapter reconnects on every close code by default, with capped
 * exponential backoff. That is right for a dropped network or a restarting
 * runtime, and wrong for a refusal: retrying something the runtime will refuse
 * identically forever produces an invisible loop — no error surfaced, a
 * "reconnecting" status that never resolves, and a fresh connection attempt every
 * 15 seconds for as long as the tab stays open.
 *
 * Kept dependency-free so the rule can be tested on its own; `WebSocketClient`
 * only decides what to do with the answer.
 */

/** The gateway/runtime could not authenticate the visitor. */
const AUTH_FAILURE_CLOSE_CODE = 4001;

/** The runtime refused this session id for this visitor (RFC 6455 policy violation). */
const SESSION_REFUSED_CLOSE_CODE = 1008;

/**
 * Reason to show when `code` means "do not reconnect", or `null` when the code is
 * retryable and the adapter should keep its normal behaviour.
 *
 * 1013 ("try again later") is intentionally retryable: it means the runtime is at
 * session capacity right now, which is exactly the case where backing off and
 * trying again works.
 */
export function terminalCloseReason(code: number | undefined): string | null {
  if (code === AUTH_FAILURE_CLOSE_CODE) {
    return 'Authentication error';
  }
  if (code === SESSION_REFUSED_CLOSE_CODE) {
    return 'This conversation belongs to a different account. Start a new one to continue.';
  }
  return null;
}
