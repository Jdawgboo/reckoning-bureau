/**
 * Applies a client `state.update` to the session's `uiState` StateTree node.
 *
 * Latest-wins full replace: the client owns the uiState/data-model and sends the
 * whole value (A2UI's `sendDataModel` model), so no server-side merge. Writing
 * the node fires the `bindStateUiState` subscription, which broadcasts the
 * STATE_SNAPSHOT to all connected tabs — this function does not broadcast
 * directly (single emission path).
 *
 * Kept standalone (not inline in MessageProcessor) so it is node-loadable and
 * unit-testable; the `UiStateWritable` structural param lets `StateTree`
 * satisfy it without a cast.
 */

import { isRecord } from '../util/type-guards.ts';

/** The narrow slice of StateTree this needs; `StateTree` satisfies it structurally. */
export interface UiStateWritable {
  sessions: {
    get(sessionId: string): {
      uiState: { set(value: Record<string, unknown>): Promise<void> };
    };
  };
}

export async function applyUiStateUpdate(
  stateTree: UiStateWritable | null,
  sessionKey: string,
  value: unknown,
): Promise<{ accepted: boolean }> {
  if (!isRecord(value)) {
    throw new Error('state.update requires an object `value`');
  }
  if (!stateTree) {
    return { accepted: false }; // degraded deploy: no state layer
  }
  await stateTree.sessions.get(sessionKey).uiState.set(value);
  return { accepted: true };
}
