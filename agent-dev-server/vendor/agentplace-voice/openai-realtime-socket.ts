import WebSocket from 'ws';
import { getVoiceLogger } from './util/logger.ts';
import { isRecord } from './util/type-guards.ts';

const logger = getVoiceLogger();

/**
 * Duplex OpenAI Realtime JSON-event transport. This abstracts wire ownership,
 * not provider protocol semantics.
 */
export interface RealtimeSocket {
  send(event: Record<string, unknown>): void;
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  /**
   * The peer went away. `code` and `reason` are the WebSocket close frame's,
   * where the transport has them.
   *
   * They are carried because on some providers the close code is the *only*
   * report of why: Gemini Live states a context-window exhaustion as close 1007
   * and a rejected session as 1008, with no error frame beforehand. A handler
   * that ignores both arguments stays valid, which is why they are optional.
   */
  onClose(handler: (code?: number, reason?: string) => void): void;
  /**
   * Post-open transport failures. Optional so existing implementations (and
   * test doubles) stay valid, but a transport that omits it makes a socket
   * error indistinguishable from a clean hangup — which on a phone call is the
   * difference between "the caller rang off" and "we dropped them".
   */
  onError?(handler: (error: Error) => void): void;
  close(): void;
}

/** Connect to any realtime-protocol WS endpoint (direct provider or a
 *  platform relay that holds the provider key). */
export function connectRealtime(params: {
  url: string;
  headers?: Record<string, string>;
}): Promise<RealtimeSocket> {
  const ws = new WebSocket(params.url, { headers: params.headers });
  return new Promise((resolve, reject) => {
    const eventHandlers: Array<(event: Record<string, unknown>) => void> = [];
    const closeHandlers: Array<(code?: number, reason?: string) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    let opened = false;
    ws.on('message', (raw) => {
      const event = parseEventFrame(raw.toString());
      if (!event) {
        return;
      }
      for (const handler of eventHandlers) {
        guard('an event handler', () => handler(event));
      }
    });
    ws.on('close', (code: number, reason: Buffer) => {
      for (const handler of closeHandlers) {
        guard('a close handler', () => handler(code, reason.toString()));
      }
    });
    ws.on('error', (error: Error) => {
      if (!opened) {
        reject(error);
        return;
      }
      for (const handler of errorHandlers) {
        guard('an error handler', () => handler(error));
      }
    });
    ws.on('open', () => {
      opened = true;
      resolve({
        send: (event) => ws.send(JSON.stringify(event)),
        onEvent: (handler) => eventHandlers.push(handler),
        onClose: (handler) => closeHandlers.push(handler),
        onError: (handler) => errorHandlers.push(handler),
        close: () => ws.close(),
      });
    });
  });
}

/** How much of an unreadable frame is quoted in the log line. */
const FRAME_PREVIEW_CHARS = 200;

/**
 * One inbound frame as an event, or null when it is not a JSON object.
 *
 * Guarded rather than trusted because this endpoint is not always the provider
 * itself: anything routing in front of it can answer with a body of its own,
 * and an HTML error page from a proxy is the ordinary case. A throw out of the
 * socket's `message` callback has nothing above it to catch it, so one
 * unreadable frame would end the whole process — and with it every other
 * conversation it is carrying. Dropping the frame with a log line keeps the
 * blast radius at the frame.
 */
function parseEventFrame(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('[RealtimeSocket] dropped a frame that is not JSON', {
      bytes: raw.length,
      preview: raw.slice(0, FRAME_PREVIEW_CHARS),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!isRecord(parsed)) {
    logger.warn('[RealtimeSocket] dropped a frame that is not a JSON object', {
      bytes: raw.length,
      preview: raw.slice(0, FRAME_PREVIEW_CHARS),
    });
    return null;
  }
  return parsed;
}

/**
 * Runs one subscriber without letting it decide the fate of the others.
 *
 * Handlers are independent subscriptions, and they run inside the socket's own
 * callbacks: a throw from one both skips every handler queued behind it and
 * escapes to the process, which is a far larger failure than whatever the
 * handler tripped over.
 */
function guard(what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    logger.error(`[RealtimeSocket] ${what} threw; the rest still run`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function connectOpenAiRealtime(params: {
  apiKey: string;
  model: string;
}): Promise<RealtimeSocket> {
  return connectRealtime({
    url: `wss://api.openai.com/v1/realtime?model=${params.model}`,
    headers: { Authorization: `Bearer ${params.apiKey}` },
  });
}
