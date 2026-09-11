import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WsSessionManager } from '../../ws/session-manager';
import type { DependencyContainer } from '../../container';
import type { Route } from './route';

const PATH = '/api/session-snapshot';

export function createSessionSnapshotRoute(
  sessionManager: WsSessionManager,
  container?: DependencyContainer,
): Route {
  return {
    matches: (method, url) => method === 'GET' && (url === PATH || url.startsWith(PATH + '?')),

    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const sessionId = parsed.searchParams.get('session_id');

      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_id is required' }));
        return;
      }

      const session = sessionManager.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      if (session.status === 'processing') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session is processing', retryAfter: 2 }));
        return;
      }

      // Load conversation history from SessionManager (persistent)
      const agentSessionManager = container?.getSessionManager();
      const conversationHistory = agentSessionManager
        ? (await agentSessionManager.loadConversation(session.sessionKey)).map(
            (m: { data: unknown }) => m.data,
          )
        : [];
      const storedContents = await session.getStoredContents(0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sessionKey: session.sessionKey,
          conversationHistory,
          storedContents,
          lastTurnError: session.lastTurnError,
          snapshotTimestamp: Date.now(),
        }),
      );
    },
  };
}
