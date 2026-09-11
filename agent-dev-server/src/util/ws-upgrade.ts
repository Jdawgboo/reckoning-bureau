import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { log } from './logger.ts';

/** The request values Node supplies to an HTTP upgrade listener. */
export interface WsUpgrade {
  req: http.IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

const INTERNAL_ERROR_CLOSE_CODE = 1011;

/** Parse the request pathname against a fixed base, returning null when malformed. */
export function upgradePathname(req: Pick<http.IncomingMessage, 'url'>): string | null {
  try {
    return new URL(req.url || '', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/** Parse request query parameters without depending on the Host header. */
export function upgradeSearchParams(req: Pick<http.IncomingMessage, 'url'>): URLSearchParams {
  try {
    return new URL(req.url || '', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Complete an upgrade with an error listener attached before the endpoint
 * receives the WebSocket. Endpoint-specific listeners may add their own
 * cleanup and logging.
 */
export function acceptUpgrade(
  wss: WebSocketServer,
  upgrade: WsUpgrade,
  label: string,
  onConnection: (ws: WebSocket) => void,
): void {
  wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
    ws.on('error', (error: Error) => {
      log('info', { event: 'ws.socket.error', label, error: error.message });
    });
    try {
      onConnection(ws);
    } catch (error) {
      log('error', {
        event: 'ws.connection.handler_threw',
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      ws.close(INTERNAL_ERROR_CLOSE_CODE, 'Internal error');
    }
  });
}
