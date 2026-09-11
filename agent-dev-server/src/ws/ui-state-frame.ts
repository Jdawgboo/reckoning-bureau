/**
 * Builds the AG-UI STATE_SNAPSHOT wire frame for a session's `uiState` node.
 *
 * Kept as a standalone pure function (rather than inline in AgentSession) so it
 * is unit-testable without loading AgentSession's full runtime import graph. The
 * deployed client has no StateTree, so `uiState` is delivered over the `agui`
 * channel as a STATE_SNAPSHOT; the empty `responseId` marks it as not
 * run-scoped.
 */

import { aguiEvent, type AguiEvent } from '../../vendor/agent-library/agui/events.ts';
import type { AguiFrame } from '../../../shared/ws-protocol.ts';

export function uiStateSnapshotFrame(
  snapshot: Record<string, unknown> | null,
): AguiFrame<AguiEvent> {
  return {
    responseId: '',
    event: aguiEvent.stateSnapshot({ scope: '/uiState', snapshot: snapshot ?? {} }),
  };
}
