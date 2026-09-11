/**
 * Shared stream consumer — iterates an AgentContent stream, broadcasts to
 * connected clients, stores content, and emits finish/error signals.
 *
 * Used by both the WebSocket MessageProcessor and the HTTP send-message route.
 */

import type { AgentSession } from '../ws/agent-session';
import type { FinishSignalContent, ErrorSignalContent } from '../../../shared';
import { ContentType, type AgentContent, type ToolContent } from '../bl/agent/agent-library.ts';
import { log } from './logger.ts';

/**
 * Logs one line per tool call when it reaches a terminal streaming state
 * (`output-available` / `output-error`), deduped by toolCallId within the run.
 * This is the only place tool executions surface in the agent logs.
 */
function logTerminalToolCall(
  content: AgentContent,
  responseId: string,
  logged: Set<string>,
  channel: string | undefined,
): void {
  if (content.type !== ContentType.Component && content.type !== ContentType.Tool) {
    return;
  }
  const streaming = content.streaming;
  if (!streaming || logged.has(streaming.toolCallId)) {
    return;
  }
  if (streaming.state !== 'output-available' && streaming.state !== 'output-error') {
    return;
  }
  logged.add(streaming.toolCallId);
  const errorText =
    'error' in streaming && typeof streaming.error === 'string'
      ? streaming.error.slice(0, 200)
      : undefined;
  log(streaming.state === 'output-error' ? 'warn' : 'info', {
    event: 'agent.toolCall',
    toolName: streaming.toolName,
    toolCallId: streaming.toolCallId,
    state: streaming.state,
    responseId,
    ...(channel ? { channel } : {}),
    ...(errorText ? { error: errorText } : {}),
  });
}

export async function consumeContentStream(
  session: AgentSession,
  stream: AsyncIterable<AgentContent>,
  responseId: string,
  channel?: string,
): Promise<void> {
  const loggedToolCalls = new Set<string>();
  try {
    for await (const content of stream) {
      if (!content) {
        continue;
      }

      logTerminalToolCall(content, responseId, loggedToolCalls, channel);
      const contentWithResponseId = { ...content, responseId };
      session.broadcastContent(contentWithResponseId);
      session.pushContent(contentWithResponseId);
    }

    const finishContent: FinishSignalContent = {
      type: 'finish',
      messageId: 'finish',
      responseId,
    };
    session.broadcastContent(finishContent);
  } catch (error) {
    const errorContent: ErrorSignalContent = {
      type: 'error',
      messageId: 'error',
      error: error instanceof Error ? error.message : String(error),
      responseId,
    };
    session.broadcastContent(errorContent);

    log('error', {
      event: 'stream.error',
      sessionKey: session.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
