import type { ServerResponse } from 'node:http';
import type { WsSessionManager } from '../../ws/session-manager';
import type { DependencyContainer } from '../../container';
import type { Route } from './route';

export function createConversationHistoryRoute(
  sessionManager: WsSessionManager,
  container?: DependencyContainer,
): Route {
  return {
    matches: (method, url) =>
      method === 'GET' && (url === '/api/conversation-history' || url === '/conversation-history'),
    handler: async (_req, res: ServerResponse) => {
      const sessionKey = sessionManager.getCurrentSessionKey();
      if (!sessionKey) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionKey: null, conversationHistory: [] }));
        return;
      }

      // Load from persistent SessionManager
      const agentSessionManager = container?.getSessionManager();
      const conversationHistory = agentSessionManager
        ? (await agentSessionManager.loadConversation(sessionKey)).map(
            (m: { data: unknown }) => m.data,
          )
        : [];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionKey, conversationHistory }));
    },
  };
}
