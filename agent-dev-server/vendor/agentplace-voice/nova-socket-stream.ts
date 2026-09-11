/**
 * Nova Sonic reached over a JSON-frame socket instead of the AWS SDK.
 *
 * `nova-bedrock-stream.ts` is the direct path: a caller holding AWS credentials
 * opens `InvokeModelWithBidirectionalStream` itself. A caller that holds NO
 * provider credential cannot — it reaches every provider through one authenticated
 * WebSocket to something that holds them, and that intermediary terminates the
 * socket and re-originates the Bedrock call on its behalf.
 *
 * Nova's own frames cross that socket unchanged: **one JSON object per WebSocket
 * message**, in both directions, exactly the `{ event: { … } }` shape
 * {@link NovaBidirectionalStream} already carries. So the only thing missing is
 * the shape change — a socket pushes, a bidirectional stream is pulled — and that
 * is all this file does. Nothing here parses, rewrites, batches or reorders a
 * frame; a bridge that understood Nova's protocol would be a second place for it
 * to be understood differently.
 *
 * ## Why the receive side needs a queue
 *
 * {@link RealtimeSocket.onEvent} pushes a frame the instant it arrives, while
 * {@link NovaBidirectionalStream.events} is an async iterable the adapter pulls
 * from — and it starts pulling *after* the first frames may already have landed.
 * Buffering is therefore not an optimisation: without it, the frames that arrive
 * between the socket opening and the first pull are dropped, and on Nova those are
 * exactly the ones that report the session came up.
 *
 * The queue is not the one in `nova-bedrock-stream.ts`. That one is the SEND side
 * (records in, encoded chunks out, no failure channel, because the SDK reports a
 * failed request through the response stream). This one is the RECEIVE side, and
 * has to carry a failure: a socket error is the only report a dropped connection
 * gives, and the seam defines a thrown iterable as how a stream fails.
 */

import type { NovaBidirectionalStream } from './nova-bedrock-stream.ts';
import type { RealtimeSocket } from './openai-realtime-socket.ts';
import { getVoiceLogger } from './util/logger.ts';

const logger = getVoiceLogger();

/**
 * Presents a duplex JSON-frame socket as one Nova bidirectional stream.
 *
 * The handlers are registered synchronously, before this returns, so a frame that
 * arrives while the caller is still wiring up its adapter is queued rather than
 * lost.
 *
 * A remote close completes {@link NovaBidirectionalStream.events} rather than
 * throwing it: the socket going away is how this transport reports the stream
 * ending, and the seam's contract is that completion means ended and a throw
 * means failed. A transport ERROR does throw, because a call that dropped is not
 * a call that finished.
 */
export function novaStreamOverSocket(socket: RealtimeSocket): NovaBidirectionalStream {
  const inbound = new InboundFrameQueue();
  let closed = false;
  socket.onEvent((frame) => inbound.push(frame));
  socket.onClose((code, reason) => {
    logger.info('[NovaSocketStream] transport closed', { code, reason });
    inbound.end();
  });
  socket.onError?.((error) => inbound.fail(error));
  return {
    send: (frame) => {
      if (closed) {
        return;
      }
      socket.send(frame);
    },
    events: () => inbound.drain(),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      socket.close();
    },
  };
}

/**
 * Frames pushed by the socket, pulled by the adapter.
 *
 * A plain array plus a wake-up promise rather than a stream library, for the same
 * reason its send-side counterpart is: the whole contract is "yield what is
 * queued, then wait", and what is waiting for it asks for nothing more than an
 * async iterable.
 *
 * A failure is raised only once the queue in front of it has drained — the frames
 * that did arrive are facts about the call, and a transcript or a usage figure
 * already on the wire should not be lost because the connection died a moment
 * later.
 */
class InboundFrameQueue {
  #frames: Record<string, unknown>[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #failure: Error | null = null;

  push(frame: Record<string, unknown>): void {
    if (this.#ended) {
      return;
    }
    this.#frames.push(frame);
    this.#release();
  }

  end(): void {
    this.#ended = true;
    this.#release();
  }

  fail(error: Error): void {
    if (this.#ended) {
      return;
    }
    this.#failure = error;
    this.#ended = true;
    this.#release();
  }

  async *drain(): AsyncIterable<Record<string, unknown>> {
    while (true) {
      const next = this.#frames.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#failure) {
        throw this.#failure;
      }
      if (this.#ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #release(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
