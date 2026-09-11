/**
 * Drains the native AG-UI event stream from a run and broadcasts each event to
 * connected clients on the `agui` channel, in parallel with `consumeContentStream`.
 * Each frame carries the run's `responseId`, which the client's stream FSM uses to gate
 * terminal signals. The stream is self-terminating (its own RUN_FINISHED / RUN_ERROR
 * event is the terminal signal), so no separate finish frame is emitted here.
 */

import type { AgentSession } from '../ws/agent-session';
import { AGUI_STREAM_METHOD, type AguiFrame } from '../../../shared/ws-protocol.ts';
import type { AguiEvent } from '../bl/agent/agent-library';
import { log } from './logger.ts';

export async function consumeAguiStream(
  session: AgentSession,
  stream: AsyncIterable<AguiEvent>,
  responseId: string,
): Promise<void> {
  try {
    for await (const event of stream) {
      const frame: AguiFrame<AguiEvent> = { responseId, event };
      session.broadcast({ method: AGUI_STREAM_METHOD, params: frame });
      session.recordA2uiEvent(event, responseId);
    }
  } catch (error) {
    log('error', {
      event: 'agui-stream.error',
      sessionKey: session.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
