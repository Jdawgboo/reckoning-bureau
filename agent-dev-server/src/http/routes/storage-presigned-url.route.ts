import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DependencyContainer } from '../../container.ts';
import type { Route } from './route.ts';
import { fetchPresignedDownloadUrl } from '../../services/platform-storage-client.ts';

const PATH = '/api/storage/presigned-url';
const SESSION_ID_HEADER = 'x-agentplace-session-id';
const COMMON_BRANCH_PREFIX = 'common/';
const PRIVATE_BRANCH_PREFIX = 'private/';

/**
 * Maps a reference path to the platform `location` + in-location path: a leading `common/`
 * → common storage; `private/` or no prefix → the current session (location = session header).
 */
function resolveBranchLocation(
  path: string,
  sessionLocation: string | undefined,
): { filePath: string; location: string | undefined } {
  if (path.startsWith(COMMON_BRANCH_PREFIX)) {
    return { filePath: path.slice(COMMON_BRANCH_PREFIX.length), location: 'common' };
  }
  if (path.startsWith(PRIVATE_BRANCH_PREFIX)) {
    return { filePath: path.slice(PRIVATE_BRANCH_PREFIX.length), location: sessionLocation };
  }
  return { filePath: path, location: sessionLocation };
}

/**
 * GET /api/storage/presigned-url?path=&disposition= → `{ url, expiresAt }`. A `common/` path
 * prefix resolves common storage; otherwise the session header pins the private namespace.
 */
export function createStoragePresignedUrlRoute(container: DependencyContainer): Route {
  return {
    matches: (method, url) => method === 'GET' && (url === PATH || url.startsWith(`${PATH}?`)),

    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const disposition =
        parsed.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';

      const path = parsed.searchParams.get('path')?.trim();
      if (!path) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path query parameter is required' }));
        return;
      }

      const sessionHeader = req.headers[SESSION_ID_HEADER];
      const sessionLocation = typeof sessionHeader === 'string' ? sessionHeader : undefined;
      const { filePath, location } = resolveBranchLocation(path, sessionLocation);

      const factory = container.getAgentStorageFactoryService();
      const apiBaseUrl = factory.getApiBaseUrl();
      const accessKey = factory.getAccessKey();

      try {
        const result = await fetchPresignedDownloadUrl({
          apiBaseUrl,
          accessKey,
          filePath,
          location,
          disposition,
        });
        if ('reason' in result) {
          if (result.reason === 'not-found') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `file not found: ${path}` }));
            return;
          }
          // zstd-stored files can't be served via direct S3 GET — 409 so
          // the client can surface a readable explanation.
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'file is stored compressed', code: 'compressed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: result.url, expiresAt: result.expiresAt }));
      } catch (error) {
        // Log detail server-side; surface a generic message so internal
        // URLs / AWS signatures never leak to the browser.
        const detail = error instanceof Error ? error.message : 'unknown error';
        console.warn('[storage-presigned-url]', path, detail);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to mint presigned URL' }));
      }
    },
  };
}
