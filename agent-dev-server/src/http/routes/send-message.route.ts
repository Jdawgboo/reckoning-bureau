/**
 * Send Message Route — fire-and-forget HTTP messaging API.
 *
 * POST /api/send-message accepts a message, returns 202 immediately,
 * and processes in the background. Connected WebSocket clients observe
 * the response via the existing content broadcast system.
 */

import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WsSessionManager } from '../../ws/session-manager.ts';
import type { DependencyContainer } from '../../container.ts';
import type { AgentSession } from '../../ws/agent-session.ts';
import type { Route } from './route.ts';
import type { ErrorSignalContent } from '../../../../shared';
import { parseJsonBody } from './parse-json-body.ts';
import { createTextContent } from '../../bl/agent/agent-library.ts';
import { log } from '../../util/logger.ts';
import { getConfigId } from '../../util/config.ts';
import { consumeContentStream } from '../../util/consume-content-stream.ts';
import { consumeAguiStream } from '../../util/consume-agui-stream.ts';
import { isRecord } from '../../util/type-guards.ts';
import {
  ClickResolutionError,
  hasClickRequest,
  resolveClickMetadata,
} from '../../ws/click-request.ts';

/** Channel truth, authored by this adapter — rides the `presentation`
 *  parameter (the same seam the web client uses), never the instruction. */
/** Superseded by the per-turn `<turn_situation>` block, which states the same fact
 *  (no live screen) for every channel in one place. Kept only until this route's
 *  callers are verified against it. */
const HTTP_CHANNEL_PRESENTATION = [
  '<presentation>',
  'You are answering an HTTP API caller — a programmatic client, not a browser. There is no live screen: any screen you render reaches the caller as its markdown fallback. Prefer direct, complete, well-formatted text; render a screen only when its structured content is the best answer, and make its fallbackMarkdown a complete standalone answer.',
  '</presentation>',
].join('\n');

type SendMessageDeps = {
  sessionManager: WsSessionManager;
  container: DependencyContainer;
};

export function createSendMessageRoute(deps: SendMessageDeps): Route {
  const { sessionManager, container } = deps;
  const configId = getConfigId(container);

  return {
    matches: (method, url) => method === 'POST' && url === '/api/send-message',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let body: { session_id?: string; message?: string; metadata?: unknown };
      try {
        body = await parseJsonBody(req);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode ?? 400;
        const message = err instanceof Error ? err.message : 'Bad request';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        return;
      }

      if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'message is required' }));
        return;
      }

      if (body.metadata !== undefined && !isRecord(body.metadata)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'metadata must be an object when provided' }));
        return;
      }
      // `a2uiAction` and `channel` are the resolver's to set. Accepting them from a caller
      // would let anyone hand the agent an action labelled trusted without a screen behind
      // it, which is the guard press-by-name exists to preserve.
      const {
        a2uiAction: _forged,
        channel: _channelOverride,
        ...requestMetadata
      } = isRecord(body.metadata) ? body.metadata : {};

      const sessionKey = body.session_id || randomUUID();
      const userId = (req.headers['x-user-id'] as string) || 'api-user';

      const session = await sessionManager.getOrCreate(sessionKey, { userId, configId });

      if (session.status === 'processing') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session is processing', retryAfter: 2 }));
        return;
      }

      // Claimed before the awaits below, or two concurrent presses both clear the check.
      session.setStatus('processing');

      let click: { metadata: Record<string, unknown>; message: string; isAction: boolean } | null;
      try {
        // A click needs the screen it refers to, and priming is started but not awaited on
        // the session-create path, so an immediate press could otherwise see no surface.
        if (hasClickRequest(requestMetadata)) {
          await sessionManager.whenPrimed(sessionKey);
        }
        click = resolveClickMetadata(requestMetadata, (request) =>
          session.resolveClick(request, container.getSurfaceContracts()),
        );
      } catch (err: unknown) {
        session.setStatus('idle');
        if (err instanceof ClickResolutionError) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: 'click_unresolved' }));
          return;
        }
        throw err;
      }

      const responseId = randomUUID();
      session.notifyTurnAccepted(responseId);

      processInBackground({
        session,
        message: click?.message ?? body.message,
        metadata: click ? withChannel(click) : { ...requestMetadata, channel: 'http' },
        isClick: click?.isAction === true,
        responseId,
        container,
        configId,
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionKey, responseId, accepted: true }));
    },
  };
}

/** A control with no declared action behind it sends an ordinary message, so it keeps the
 *  transport's own channel; only a trusted action claims the screen channel. */
function withChannel(click: {
  metadata: Record<string, unknown>;
  isAction: boolean;
}): Record<string, unknown> {
  return click.isAction ? click.metadata : { ...click.metadata, channel: 'http' };
}

async function processInBackground(opts: {
  session: AgentSession;
  message: string;
  metadata: Record<string, unknown>;
  isClick: boolean;
  responseId: string;
  container: DependencyContainer;
  configId: string;
}): Promise<void> {
  const { session, message, metadata, isClick, responseId, container, configId } = opts;
  const startTime = Date.now();

  try {
    const userMessageContent = createTextContent({
      messageId: `user-${randomUUID()}`,
      content: message,
      role: 'user',
    });
    session.broadcastContent({ ...userMessageContent, responseId });
    session.pushContent(userMessageContent);

    const messagingService = container.createMessagingService();
    const instruction = container.createInstructionService().getInstruction();

    const result = await messagingService.sendMessage({
      configId,
      message: { type: 'TXT', content: message },
      instruction,
      // A click came from a rendered screen, so telling the agent there is no live screen
      // would contradict the action it is being handed.
      presentation: isClick ? undefined : HTTP_CHANNEL_PRESENTATION,
      sessionKey: session.sessionKey,
      sessionType: 'api',
      metadata,
    });

    // Drain AG-UI alongside content, as the WebSocket and MCP routes do. Without it the
    // session records no surfaces, so nothing can later resolve an action on this screen
    // and a co-viewing client sees no stage.
    const aguiDrain = consumeAguiStream(session, result.agui, responseId);
    try {
      await consumeContentStream(session, result.stream, responseId);
    } finally {
      await aguiDrain;
    }

    // A run that gave up ends here indistinguishably from one that answered: an apology in
    // plain text and a clean stream. Its own verdict is the only thing that separates them.
    const outcome = await result.done;
    if (outcome.status === 'error') {
      session.recordTurnError(
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        responseId,
      );
    }

    log('info', {
      event: 'http-message.complete',
      sessionKey: session.sessionKey,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    log('error', {
      event: 'http-message.error',
      sessionKey: session.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorContent: ErrorSignalContent = {
      type: 'error',
      messageId: 'error',
      error: error instanceof Error ? error.message : String(error),
      responseId,
    };
    session.broadcastContent(errorContent);
  } finally {
    session.setStatus('idle');
  }
}
