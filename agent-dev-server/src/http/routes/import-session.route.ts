import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WsSessionManager } from '../../ws/session-manager';
import type { DependencyContainer } from '../../container';
import type { Route } from './route';
import { parseJsonBody } from './parse-json-body';
import { getConfigId } from '../../util/config';

const PATH = '/api/import-session';

interface ImportSessionBody {
  session_id: string;
  conversationHistory?: unknown[];
  storedContents?: { content: unknown }[];
}

export function createImportSessionRoute(deps: {
  sessionManager: WsSessionManager;
  container: DependencyContainer;
}): Route {
  const { sessionManager } = deps;
  const configId = getConfigId(deps.container);

  return {
    matches: (method, url) => method === 'POST' && url === PATH,

    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let body: ImportSessionBody;
      try {
        body = await parseJsonBody<ImportSessionBody>(req);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
        const message = err instanceof Error ? err.message : 'Bad request';
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        return;
      }

      if (!body.session_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_id is required' }));
        return;
      }

      const identity = {
        userId: (req.headers['x-user-id'] as string) || 'import-user',
        configId,
      };

      const session = await sessionManager.getOrCreate(body.session_id, identity);

      if (session.status === 'processing') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Target session is processing' }));
        return;
      }

      // Import conversation history as per-message records
      if (body.conversationHistory && body.conversationHistory.length > 0) {
        const agentSessionManager = deps.container.getSessionManager();
        if (agentSessionManager) {
          // Clear existing messages first to avoid corrupted concatenated history
          await agentSessionManager.delete(body.session_id).catch((err: unknown) => {
            console.warn('[import-session] Failed to delete old session, proceeding:', err);
          });
          await agentSessionManager.getOrCreate(body.session_id, 'web');

          for (const msg of body.conversationHistory) {
            const role = (msg as { role?: string }).role ?? 'assistant';
            await agentSessionManager.appendMessage(body.session_id, {
              role: role as 'user' | 'assistant' | 'system' | 'tool',
              timestamp: new Date().toISOString(),
              data: msg,
            });
          }
        }
      }

      const contentCount = await session.importState(body.storedContents ?? []);

      session.broadcast({
        method: 'session.imported',
        params: { sessionKey: session.sessionKey, contentCount },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sessionKey: session.sessionKey,
          imported: true,
          contentCount,
        }),
      );
    },
  };
}
