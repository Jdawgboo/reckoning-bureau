import { WebSocketServer, type WebSocket } from 'ws';
import { acceptUpgrade, upgradePathname, upgradeSearchParams } from '../util/ws-upgrade.ts';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { WebSocketServerAdapter } from '../../vendor/agentplace-transport/adapters/WebSocketServerAdapter';
import { RpcPeer } from '../../vendor/agentplace-transport/RpcPeer';
import { WsSessionManager } from './session-manager';
import { describeAdmissionFailure } from './session-admission.ts';
import type { AgentSession } from './agent-session';
import type { DependencyContainer } from '../container';
import { MessageProcessor } from './message-processor';
import { extractSessionIdentity } from '../sdk/session-id';
import { createCallerFactory, createTRPCContext } from '../trpc/init';
import { RecordsClient } from '../bl/records/records-client';
import type { AppRouter } from '../trpc/router';
import type { AgentStorageFactoryService } from '../services/agent-storage-factory.service';
import { ActionLog } from '../bl/action-log/action-log';
import { AGUI_STREAM_METHOD, STATE_UPDATE_METHOD } from '../../../shared/ws-protocol.ts';
import {
  LOCALE_ACTIVATED_METHOD,
  LOCALE_HINT_METHOD,
  LOCALE_PROPOSE_METHOD,
  type LocaleActivatedParams,
  type LocaleHintParams,
  type LocaleProposeParams,
} from '../../../shared/index.ts';
import { isRecord } from '../util/type-guards.ts';
import type { SessionLocalizationService } from './session-localization.service.ts';
import { bindRequestsToReadyContext } from './request-readiness.ts';

/** An additional WS endpoint sharing the HTTP server (e.g. the voice gateway). */
export interface UpgradeHandler {
  path: string;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export interface WebSocketHandlerOptions {
  httpServer: Server;
  container: DependencyContainer;
  sessionManager?: WsSessionManager;
  sessionTtlMs?: number;
  appRouter?: AppRouter;
  storageFactory?: AgentStorageFactoryService;
  /** Shared processor so other inputs (voice) start turns on the same active-stream registry. */
  messageProcessor?: MessageProcessor;
  localizationService?: SessionLocalizationService;
  upgradeHandlers?: readonly UpgradeHandler[];
}

type SessionRequest = { method: string; [key: string]: unknown };

/**
 * Creates and manages WebSocket connections for the agent dev server
 */
export function createWebSocketHandler(options: WebSocketHandlerOptions): {
  sessionManager: WsSessionManager;
  shutdown: () => void;
} {
  const {
    httpServer,
    container,
    sessionTtlMs = 60 * 60 * 1000,
    appRouter,
    storageFactory,
  } = options;

  // Create tRPC caller factory if router is provided (for WS-based tRPC invocation)
  const trpcCallerFactory = appRouter ? createCallerFactory(appRouter) : null;

  const sessionManager =
    options.sessionManager ??
    new WsSessionManager({
      ttlMs: sessionTtlMs,
      messageLocaleSelector: options.localizationService
        ? (locale) => options.localizationService?.selectMessageLocale(locale) ?? locale
        : undefined,
    });
  if (!options.sessionManager) {
    sessionManager.startCleanup();
  }

  const messageProcessor = options.messageProcessor ?? new MessageProcessor({ container });
  const upgradeHandlers = options.upgradeHandlers ?? [];

  // noServer + manual routing: `ws` aborts any upgrade whose path does not
  // match its own when bound with {server, path}, which breaks co-hosted
  // endpoints like /voice. Unknown paths keep the old refusal behavior (400).
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Throw-proof by construction: the target and Host arrive verbatim from
    // the wire, and an exception here has nothing above it but the process.
    const pathname = upgradePathname(req);
    if (pathname === '/ws') {
      acceptUpgrade(wss, { req, socket, head }, '/ws', (ws) => wss.emit('connection', ws, req));
      return;
    }
    const handler = upgradeHandlers.find((candidate) => candidate.path === pathname);
    if (handler) {
      handler.handleUpgrade(req, socket, head);
      return;
    }
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  console.log(
    JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      event: 'websocket.server.created',
      path: '/ws',
    }),
  );

  wss.on('connection', (ws: WebSocket, req) => {
    handleConnection(ws, req).catch((error) => {
      // A refused connection is a policy outcome, not a server fault — it gets
      // its own close code so the client can tell "never retry this session id"
      // from "the runtime broke".
      const refusal = describeAdmissionFailure(error);
      if (refusal) {
        log('warn', {
          event: 'client.connection.refused',
          code: refusal.code,
          reason: refusal.reason,
        });
        ws.close(refusal.code, refusal.reason);
        return;
      }
      console.error('Error handling WebSocket connection:', error);
      ws.close(1011, 'Internal error');
    });
  });

  function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>) {
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(JSON.stringify({ level, timestamp: new Date().toISOString(), ...data }));
  }

  async function handleConnection(ws: WebSocket, req: any) {
    const adapter = new WebSocketServerAdapter(ws); // heartbeat built-in
    const rpcPeer = new RpcPeer(adapter);
    const connectionId = randomUUID();

    const querySessionId = upgradeSearchParams(req).get('agent_session_id');

    // Extract identity from request headers (X-User-Id injected by gateway)
    const identity = extractSessionIdentity(req);
    // The query param wins, and deliberately so: it is how every host that
    // embeds this agent asks to resume a conversation. The alternative
    // (`identity.sessionId`) is no more trustworthy — it reads the
    // `x-agentplace-session-id` header the browser itself sets, falling back to
    // a fresh id. Neither side of this `||` is trusted input, which is why who
    // may attach is decided in `getOrCreate` rather than on this line.
    const sessionKey = querySessionId || identity.sessionId;
    const userId = identity.userId;
    const configId = identity.configId;

    const t0 = Date.now();
    const sessionReady = sessionManager.getOrCreate(sessionKey, {
      userId,
      configId,
    });
    const sessionBound = bindRequestsToReadyContext<AgentSession, SessionRequest, unknown>(
      (handler) => rpcPeer.onMessage<SessionRequest, unknown>(handler),
      sessionReady,
      async (session, p) => {
        if (!adapter.isConnected) {
          throw new Error('Connection closed before the session became ready');
        }
        log('info', {
          event: 'message.received',
          sessionKey,
          method: p.method,
          connectionId,
        });

        try {
          switch (p.method) {
            case 'message.send':
              return messageProcessor.handleMessageSend(rpcPeer, connectionId, session, p);
            case 'message.abort':
              return messageProcessor.handleMessageAbort(session, p);
            case STATE_UPDATE_METHOD:
              return messageProcessor.handleStateUpdate(session, p);
            case LOCALE_HINT_METHOD:
              return localizationService().hint(session, connectionId, readLocaleHint(p));
            case LOCALE_PROPOSE_METHOD:
              return localizationService().propose(
                session,
                readLocaleProposal(p).locale,
                'explicit',
              );
            case LOCALE_ACTIVATED_METHOD:
              return {
                accepted: localizationService().acknowledge(
                  session,
                  connectionId,
                  readLocaleActivation(p),
                ),
              };
            case 'content.query':
              return handleContentQuery(rpcPeer, session, p);
            case 'session.info':
              return session.getInfo();
            case 'trpc':
              return handleTrpcCall(session, p);
            default:
              throw new Error(`Method not found: ${p.method}`);
          }
        } catch (error) {
          log('error', {
            event: 'handler.error',
            sessionKey,
            method: p.method,
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    );

    let attachedSession: AgentSession | null = null;
    adapter.onClose((code, reason) => {
      attachedSession?.removeClient(connectionId);
      log('info', {
        event: 'client.disconnected',
        sessionKey,
        connectionId,
        clientCount: attachedSession?.clientCount ?? 0,
        closeCode: code,
        closeReason: reason,
      });
    });

    const session = await sessionBound;
    const getOrCreateMs = Date.now() - t0;
    if (getOrCreateMs > 100) {
      log('warn', { event: 'session.getOrCreate.slow', sessionKey, ms: getOrCreateMs });
    }
    if (!adapter.isConnected) {
      return;
    }

    session.addClient(connectionId, { connectionId, rpcPeer, ws });
    attachedSession = session;

    log('info', {
      event: 'client.connected',
      sessionKey,
      userId,
      configId,
      connectionId,
      clientCount: session.clientCount,
    });

    rpcPeer
      .notify(
        {
          method: 'session.joined',
          params: { sessionKey, status: session.status, contentSeq: session.contentSeq },
        },
        { requireAck: false },
      )
      .catch(() => {});

    if (options.localizationService) {
      void options.localizationService.attach(session, connectionId);
    }
  }

  function localizationService(): SessionLocalizationService {
    if (!options.localizationService) {
      throw new Error('Localization is not configured on this server.');
    }
    return options.localizationService;
  }

  // Handler for tRPC calls over WebSocket — uses createCallerFactory for programmatic invocation
  async function handleTrpcCall(session: AgentSession, params: Record<string, unknown>) {
    if (!trpcCallerFactory || !storageFactory) {
      throw new Error('tRPC not configured on this server');
    }

    const { path, type, input } = params as {
      path: string;
      type: 'query' | 'mutation';
      input: unknown;
    };

    if (!path || !type) {
      throw new Error('Invalid tRPC call: missing path or type');
    }

    const ctx = createTRPCContext({
      sessionKey: session.sessionKey,
      actionLog: session.actionLog ?? new ActionLog(),
      storageFactory,
      session,
      records: new RecordsClient(container.getStateConnection()?.transport ?? null, {
        sessionId: session.sessionKey,
      }),
    });

    const caller = trpcCallerFactory(ctx);

    // Traverse the caller by path parts (e.g., 'platform.settings' → caller.platform.settings)
    const parts = path.split('.');
    let current: any = caller;
    for (const part of parts) {
      current = current[part];
      if (current === undefined) {
        throw new Error(`tRPC path not found: ${path} (failed at '${part}')`);
      }
    }

    if (typeof current !== 'function') {
      throw new Error(`tRPC path is not a procedure: ${path} (type: ${typeof current})`);
    }

    return current(input);
  }

  /**
   * Send the stage-resync snapshot frames (current uiState + live surfaces) to
   * the connection that just ran a full `content.query`. A reloaded tab replays
   * content from the buffer, but a2ui surface frames and uiState are
   * broadcast-and-forget — without this the stage would rebuild text only.
   * Scheduled after the ack so the query response dispatches first; the client
   * subscribes to the agui channel before querying, so no frame is missed.
   * Awaits `whenPrimed` before reading `buildResyncFrames()` — surfaces
   * rebuilt from history by a recreated session's background priming must be
   * in place first.
   */
  function scheduleStageResync(rpcPeer: RpcPeer, session: AgentSession): void {
    setImmediate(async () => {
      await sessionManager.whenPrimed(session.sessionKey);
      const frames = session.buildResyncFrames();
      if (frames.length === 0) {
        return;
      }
      log('info', {
        event: 'stage.resync',
        sessionKey: session.sessionKey,
        frameCount: frames.length,
      });
      for (const frame of frames) {
        rpcPeer
          .notify({ method: AGUI_STREAM_METHOD, params: frame }, { requireAck: false })
          .catch(() => {});
      }
    });
  }

  /**
   * Handler for content.query - returns stored content from afterSeq.
   * Awaits `whenPrimed` before touching stored contents so a recreated
   * session's background hydration (`session-hydration.ts` — replay buffer,
   * A2UI surfaces) has landed; hydration owns reconstruction from durable
   * storage entirely, so this handler only reads whatever the buffer holds
   * once priming settles — it has no read-through fallback of its own.
   */
  async function handleContentQuery(
    rpcPeer: RpcPeer,
    session: AgentSession,
    params: Record<string, unknown>,
  ) {
    const afterSeq = typeof params['afterSeq'] === 'number' ? params['afterSeq'] : 0;

    if (afterSeq < 0) {
      throw new Error('Invalid afterSeq');
    }

    await sessionManager.whenPrimed(session.sessionKey);
    const contents = await session.getStoredContents(afterSeq);

    if (afterSeq === 0) {
      scheduleStageResync(rpcPeer, session);
    }

    return {
      type: 'content.query.ack',
      items: contents,
      snapshot: null,
      snapshotEventSeq: null,
      streamStatus: session.status === 'processing' ? 'in_progress' : 'complete',
      activeRequestId: null,
    };
  }

  function shutdown() {
    console.log(
      JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        event: 'websocket.server.shutdown',
      }),
    );
    sessionManager.shutdown();
    wss.close();
  }

  return { sessionManager, shutdown };
}

function readLocaleHint(value: unknown): LocaleHintParams {
  if (!isRecord(value) || typeof value['locale'] !== 'string') {
    throw new Error('Invalid locale hint.');
  }
  const activeBundle = value['activeBundle'];
  if (activeBundle === undefined) {
    return { locale: value['locale'] };
  }
  return { locale: value['locale'], activeBundle: readLocaleActivation(activeBundle) };
}

function readLocaleProposal(value: unknown): LocaleProposeParams {
  if (!isRecord(value) || typeof value['locale'] !== 'string') {
    throw new Error('Invalid locale proposal.');
  }
  return { locale: value['locale'] };
}

function readLocaleActivation(value: unknown): LocaleActivatedParams {
  if (
    !isRecord(value) ||
    typeof value['catalogRevision'] !== 'string' ||
    typeof value['messageLocale'] !== 'string' ||
    typeof value['sessionLocaleRevision'] !== 'number' ||
    !Number.isSafeInteger(value['sessionLocaleRevision']) ||
    value['sessionLocaleRevision'] < 0
  ) {
    throw new Error('Invalid locale activation.');
  }
  return {
    catalogRevision: value['catalogRevision'],
    messageLocale: value['messageLocale'],
    sessionLocaleRevision: value['sessionLocaleRevision'],
  };
}
