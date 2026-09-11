/**
 * Deterministic messageId for the user message of a run, derived from the
 * identity of whoever originated it: the client's `requestId` for
 * client-originated sends (the client mints the same id for its optimistic
 * message before sending), or the server's `responseId` / queue event id for
 * server-originated runs (voice, queued drains, schedules). Write-ahead
 * ingress persistence, the optimistic client message, and any later emission
 * of the same user message converge on this id, so committed items reconcile
 * by id instead of relying on timing.
 */
export function userMessageIdFor(originId: string): string {
  return `um-${originId}`;
}
