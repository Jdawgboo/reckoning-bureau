/**
 * Reconnect resync: the frames a (re)connecting client needs to rebuild the stage —
 * the current uiState as a STATE_SNAPSHOT, then each live surface re-expressed as its
 * A2UI messages (idempotent under the upsert profile). Sent per-connection right after
 * `content.query` is answered, since the client is guaranteed subscribed by then and its
 * restore-buffer sequences the frames correctly. Pure helper; AgentSession delegates here.
 */

import { aguiEvent, type AguiEvent } from '../../vendor/agent-library/agui/events.ts';
import type { AguiFrame } from '../../../shared/ws-protocol.ts';
import { uiStateSnapshotFrame } from './ui-state-frame.ts';
import {
  surfaceToResyncEvents,
  type ReducedSurface,
} from '../../vendor/agentplace-a2ui/surface-reduction.ts';

const NOT_RUN_SCOPED = '';

export function buildResyncFrames(
  uiState: Record<string, unknown> | null,
  surfaces: ReadonlyMap<string, ReducedSurface>,
): Array<AguiFrame<AguiEvent>> {
  const frames: Array<AguiFrame<AguiEvent>> = [];

  // uiState first — surface bindings resolve against it as they render.
  if (uiState && Object.keys(uiState).length > 0) {
    frames.push(uiStateSnapshotFrame(uiState));
  }

  for (const surface of surfaces.values()) {
    for (const { name, value } of surfaceToResyncEvents(surface)) {
      frames.push({
        responseId: surface.responseId ?? NOT_RUN_SCOPED,
        event: aguiEvent.custom(name, value),
      });
    }
  }

  return frames;
}
