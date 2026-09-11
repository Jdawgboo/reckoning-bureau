/**
 * MessageProcessor
 *
 * Processes WebSocket messages and streams agent responses.
 * Broadcasts AgentContent directly to clients.
 */
import { randomUUID } from 'node:crypto';

import type { RpcPeer } from '../../vendor/agentplace-transport/RpcPeer';
import type { AgentSession } from './agent-session';
import type { MessageSendParams } from './agent-session.types';
import type { DependencyContainer } from '../container';
import type { ErrorSignalContent } from '../../../shared';
import { AGUI_STREAM_METHOD, type AguiFrame } from '../../../shared/ws-protocol.ts';
import {
  type AgentContent,
  type AguiEvent,
  type CancelableStream,
  createTextContent,
  aguiEvent,
  AGUI_CUSTOM_EVENT_NAMES,
} from '../bl/agent/agent-library';
import { log } from '../util/logger';
import { consumeContentStream } from '../util/consume-content-stream';
import { consumeAguiStream } from '../util/consume-agui-stream';
import { CLICK_BY_NAME_KEY, hasClickRequest } from './click-request';
import { applyUiStateUpdate } from './handle-state-update.ts';
import { resolveTurnChannel } from './resolve-turn-channel.ts';
import {
  DEFAULT_AGENT_RUN_PRESENTATION,
  type AgentRunPresentationCapability,
} from '../bl/messaging/agent-run-presentation.ts';

export interface MessageProcessorOptions {
  container: DependencyContainer;
}

export class MessageProcessor {
  #container: DependencyContainer;

  /**
   * Active streams keyed by sessionKey so we can abort the current stream
   * for a given session. Only one stream is active per session at a time.
   */
  #activeStreams = new Map<
    string,
    { responseId: string; stream: CancelableStream<AgentContent> }
  >();

  constructor(options: MessageProcessorOptions) {
    this.#container = options.container;
  }

  /**
   * The responseId of the in-flight stream for a session, if any — regardless
   * of which client started it. Lets the voice tool bridge abort "whatever is
   * running" the same way an omnibox abort button would.
   */
  getActiveResponseId(sessionKey: string): string | undefined {
    return this.#activeStreams.get(sessionKey)?.responseId;
  }

  /**
   * Handle message.abort RPC - abort the active stream for a session.
   */
  async handleMessageAbort(
    session: AgentSession,
    params: Record<string, unknown>,
  ): Promise<{ aborted: boolean; reason?: string }> {
    const responseId = params.responseId as string | undefined;

    if (!responseId || typeof responseId !== 'string') {
      throw new Error('responseId is required');
    }

    const active = this.#activeStreams.get(session.sessionKey);

    if (!active || active.responseId !== responseId) {
      return { aborted: false, reason: 'nothing_to_abort' };
    }

    log('info', {
      event: 'message.abort',
      sessionKey: session.sessionKey,
      responseId,
    });

    active.stream.abort();
    this.#activeStreams.delete(session.sessionKey);

    return { aborted: true };
  }

  /**
   * Handle a `state.update` RPC — write the session's `uiState` node. The write
   * fires the session's `bindStateUiState` subscription, which broadcasts the
   * STATE_SNAPSHOT to all connected clients (no direct broadcast here).
   */
  async handleStateUpdate(
    session: AgentSession,
    params: Record<string, unknown>,
  ): Promise<{ accepted: boolean }> {
    return applyUiStateUpdate(this.#container.getAgentState(), session.sessionKey, params.value);
  }

  async handleMessageSend(
    rpcPeer: RpcPeer,
    connectionId: string,
    session: AgentSession,
    params: Record<string, unknown>,
    runPresentation: AgentRunPresentationCapability = DEFAULT_AGENT_RUN_PRESENTATION,
  ): Promise<{ accepted?: boolean; queued?: boolean; responseId: string }> {
    const content = params.content as string | undefined;

    if (typeof content !== 'string') {
      throw new Error('content is required');
    }

    if (!content.trim() && !params.hidden) {
      throw new Error('content must not be empty');
    }

    // Press-by-name is accepted on the HTTP messaging route only, which is programmatic by
    // construction. Rejecting it here keeps the request from falling through into the
    // prompt as opaque metadata, and keeps the trusted-action guard on one entry point.
    if (hasClickRequest(params.metadata)) {
      throw new Error(
        `${CLICK_BY_NAME_KEY} is not supported over WebSocket; send it to POST /api/send-message`,
      );
    }

    const sendParams: MessageSendParams = {
      content,
      files: params.files as any,
      instruction: params.instruction as string | undefined,
      memoryBank: params.memoryBank as any,
      metadata: params.metadata as Record<string, unknown> | undefined,
      hidden: params.hidden as boolean | undefined,
      presentation: params.presentation as string | undefined,
      runPresentation,
    };

    console.log('[MessageProcessor] sendParams', JSON.stringify(sendParams, null, 2));

    // Flush action log entries accumulated since last message
    const pendingActions = session.actionLog.flush();
    if (pendingActions.length > 0) {
      sendParams.metadata = {
        ...sendParams.metadata,
        actionsSinceLastMessage: pendingActions,
      };
    }

    // A live voice connection means a listener exists for EVERY turn, whatever
    // channel it arrives on (screen click, typed, voice). The flag reaches the
    // model via the internal_request_metadata block, so it can end turns worth
    // voicing with a spoken closing line.
    if (session.voiceChannelActive) {
      sendParams.metadata = {
        ...sendParams.metadata,
        voice_active: true,
      };
    }

    const responseId = randomUUID();

    console.log('[MessageProcessor] session.status', session.status);
    if (session.status === 'processing') {
      const queued = session.queueMessage(
        randomUUID(),
        sendParams,
        rpcPeer,
        connectionId,
        responseId,
      );
      if (!queued) {
        throw new Error('Message already pending');
      }
      session.notifyTurnAccepted(responseId);
      return { queued: true, responseId };
    }

    session.setStatus('processing');
    session.notifyTurnAccepted(responseId);

    log('info', {
      event: 'message.processing',
      sessionKey: session.sessionKey,
      contentLength: content.length,
    });

    this.#executeMessage(session, sendParams, responseId, connectionId);

    return { accepted: true, responseId };
  }

  /**
   * Run message processing in the background.
   * Not awaited — the RPC response is sent before processing starts.
   */
  #executeMessage(
    session: AgentSession,
    params: MessageSendParams,
    responseId: string,
    connectionId: string,
  ): void {
    const startTime = Date.now();
    log('info', { event: 'message.start', sessionKey: session.sessionKey, responseId });
    this.processMessage(session, params, responseId, connectionId)
      .then(() => {
        log('info', {
          event: 'message.complete',
          sessionKey: session.sessionKey,
          responseId,
          durationMs: Date.now() - startTime,
        });
      })
      .catch((error) => {
        log('error', {
          event: 'agent.error',
          sessionKey: session.sessionKey,
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
          stack: error instanceof Error ? error.stack : undefined,
        });
        const errorContent: ErrorSignalContent = {
          type: 'error',
          messageId: 'error',
          error: error instanceof Error ? error.message : String(error),
          responseId,
        };
        session.broadcastContent(errorContent);
      })
      .finally(() => {
        session.setStatus('idle');
        this.processQueuedMessage(session);
      });
  }

  private async processMessage(
    session: AgentSession,
    params: MessageSendParams,
    responseId: string,
    connectionId: string,
  ): Promise<void> {
    const messagingService = this.#container.createMessagingService();

    const message = {
      type: 'TXT' as const,
      content: params.content,
    };

    // Always emit user message as content; client decides rendering via `hidden`
    const userMessageContent = createTextContent({
      messageId: `user-${randomUUID()}`,
      content: params.content,
      role: 'user',
      hidden: params.hidden || undefined,
      channel: resolveTurnChannel(params.metadata),
    });
    const enrichedUserMessage = { ...userMessageContent, responseId };
    session.broadcastContent(enrichedUserMessage);
    this.#broadcastUserEcho(session, userMessageContent, responseId);
    session.pushContent(enrichedUserMessage);

    log('info', {
      event: 'memory.injected',
      sessionKey: session.sessionKey,
      count: params.memoryBank?.length ?? 0,
    });

    const result = await messagingService.sendMessage({
      configId: session.configId,
      message,
      instruction: params.instruction,
      files: params.files || [],
      sessionKey: session.sessionKey,
      memories: params.memoryBank,
      metadata: params.metadata,
      presentation: params.presentation,
      getSurfaceSnapshot: (surfaceId) => session.surfaceSnapshot(surfaceId),
      runPresentation: params.runPresentation,
      localizationAttachmentId: connectionId,
    });

    // Track the active stream so it can be aborted via message.abort
    this.#activeStreams.set(session.sessionKey, {
      responseId,
      stream: result.stream,
    });

    // Drain the AG-UI event stream in parallel; it self-terminates with the
    // run's RUN_FINISHED/RUN_ERROR, so it resolves alongside the content stream.
    const aguiDrain = consumeAguiStream(session, result.agui, responseId);
    try {
      await consumeContentStream(
        session,
        result.stream,
        responseId,
        resolveTurnChannel(params.metadata),
      );
    } finally {
      await aguiDrain;
      // Clean up active stream reference
      this.#activeStreams.delete(session.sessionKey);
    }
  }

  /**
   * The user message is minted here, outside the agent run, so it is not part
   * of `result.agui`. Place it on the AG-UI channel as the verbatim
   * `agentplace.content` envelope (the projector appends it unchanged — role,
   * hidden, and the server-minted messageId are preserved, so `content.query`
   * resume dedups against it by messageId).
   */
  #broadcastUserEcho(session: AgentSession, content: AgentContent, responseId: string): void {
    const enriched: AgentContent = { ...content, responseId };
    const event = aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.content, { content: enriched });
    const frame: AguiFrame<AguiEvent> = { responseId, event };
    session.broadcast({ method: AGUI_STREAM_METHOD, params: frame });
  }

  private async processQueuedMessage(session: AgentSession): Promise<void> {
    console.log('[MessageProcessor] processQueuedMessage', session.status);
    const pending = session.dequeueMessage();
    if (!pending) {
      console.log('[MessageProcessor] processQueuedMessage no pending message');
      return;
    }

    session.setStatus('processing');

    // Merge any new actions accumulated while message was queued
    const queuedActions = session.actionLog.flush();
    if (queuedActions.length > 0) {
      const existing = (pending.params.metadata?.actionsSinceLastMessage as unknown[]) || [];
      pending.params.metadata = {
        ...pending.params.metadata,
        actionsSinceLastMessage: [...existing, ...queuedActions],
      };
    }

    try {
      console.log('[MessageProcessor] processQueuedMessage notify', pending.id);
      pending.rpcPeer
        .notify(
          {
            method: 'message.started',
            params: { id: pending.id, responseId: pending.responseId },
          },
          { requireAck: false },
        )
        .catch(() => {});

      console.log('[MessageProcessor] processQueuedMessage processMessage', pending.id);
      await this.processMessage(session, pending.params, pending.responseId, pending.connectionId);
      console.log('[MessageProcessor] processQueuedMessage processMessage complete', pending.id);
    } catch (error) {
      console.log('[MessageProcessor] processQueuedMessage error', pending.id, error);
      log('error', {
        event: 'queue.error',
        sessionKey: session.sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      pending.rpcPeer
        .notify(
          {
            method: 'message.error',
            params: {
              id: pending.id,
              responseId: pending.responseId,
              error: error instanceof Error ? error.message : String(error),
            },
          },
          { requireAck: false },
        )
        .catch(() => {});
    } finally {
      session.setStatus('idle');
      this.processQueuedMessage(session);
    }
  }
}
