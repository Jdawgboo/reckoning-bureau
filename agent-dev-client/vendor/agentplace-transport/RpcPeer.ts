import type { ITransport } from './Transport';
import type { Packet, PendingTask, RequestOptions, RpcMessage, TransferableItem } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 2_000;
/** Resends of the same request after ACK silence before the task fails. */
const MAX_ACK_RETRIES = 3;
/** Incoming request ids remembered for duplicate suppression. */
const RECENT_REQUEST_CACHE_SIZE = 500;

/** Pick a short hint from a payload for diagnostic logs (no full dump). */
function describePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.method === 'string') {
    return `method=${p.method}`;
  }
  if (typeof p.type === 'string') {
    return `type=${p.type}`;
  }
  return null;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class RpcPeer {
  #handlers = new Map<string, (payload: unknown) => unknown>();
  #pending = new Map<string, PendingTask<unknown>>();
  #buffer: PendingTask<unknown>[] = [];
  #transport: ITransport;
  /**
   * REQ id → cached RES packet, or null while the handler is still running.
   * Retries re-send the SAME packet id, so a duplicate REQ here means the ACK
   * (not the request) was lost: re-ACK, replay the cached RES if finished, and
   * never run the handler twice.
   */
  #recentRequests = new Map<string, Packet | null>();

  constructor(transport: ITransport) {
    this.#transport = transport;
    this.#transport.on('message', this.#handleMessage.bind(this));

    this.#transport.on('disconnect', () => {
      console.debug(
        `[RpcPeer] Disconnected. Pausing (pending=${this.#pending.size}, buffered=${this.#buffer.length})`,
      );
      this.#recoverTasks();
    });

    this.#transport.on('connect', () => {
      console.log(`[RpcPeer] Connected. Flushing buffer (size=${this.#buffer.length})`);
      this.#flushBuffer();
    });
  }

  /**
   * Public API: Ask the remote side for something.
   *
   * Reliability contract:
   * - `options.timeout` is a hard wall-clock deadline for the task's whole life,
   *   including ACK retries and offline buffering. It never resets.
   * - On ACK silence the same packet id is re-sent at most MAX_ACK_RETRIES times;
   *   the receiver deduplicates by id, so a retry can never re-execute the handler.
   *
   * @template T - Expected response type (defaults to RpcMessage)
   */
  public ask<T = RpcMessage>(payload: unknown, options?: RequestOptions): Promise<T> {
    // Merge user options on top of defaults. Previously a partial options object
    // (e.g. { timeout: 30000 }) wiped out the defaults entirely, so `retry` became
    // undefined and ACK timeouts would reject instead of retrying.
    const merged: RequestOptions = { retry: true, requireAck: true, ...(options ?? {}) };

    if (!this.#transport.isConnected && merged.retry === false) {
      return Promise.reject(new Error('Transport offline and request is volatile'));
    }

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const task: PendingTask<T> = {
      id: crypto.randomUUID(),
      payload,
      options: merged,
      resolve: resolve as (value: unknown) => void,
      reject,
      attempts: 0,
      ackReceived: false,
    };
    this.#armDeadline(task as PendingTask<unknown>);

    if (this.#transport.isConnected) {
      this.#transmit(task as PendingTask<unknown>);
    } else {
      this.#buffer.push(task as PendingTask<unknown>);
    }

    return promise;
  }

  /**
   * Register a handler for incoming requests.
   * Only one main handler needed, dispatch based on payload.cmd manually.
   * @template TRequest - Request payload type (defaults to RpcMessage)
   * @template TResponse - Response type (defaults to unknown)
   */
  public onMessage<TRequest = RpcMessage, TResponse = unknown>(
    fn: (payload: TRequest) => TResponse | Promise<TResponse>,
  ) {
    this.#handlers.set('MAIN', fn as (payload: unknown) => unknown);
  }

  /**
   * Register a handler for incoming notifications.
   * Notifications don't expect a response, so the handler return value is ignored.
   * @template T - Notification payload type (defaults to RpcMessage)
   */
  public onNotify<T = RpcMessage>(fn: (payload: T) => void) {
    this.#handlers.set('NOTIFY', fn as (payload: unknown) => void);
  }

  /**
   * Send a notification (fire-and-forget message).
   * Unlike ask(), this does not wait for a response, only optionally for ACK.
   *
   * @template T - Payload type (defaults to RpcMessage)
   * @param payload - The notification data to send
   * @param options - Optional configuration
   * @returns Promise that resolves when ACK is received (if requireAck: true), or immediately
   *
   * @example
   * ```typescript
   * // Fire-and-forget (no confirmation)
   * await peer.notify({ event: 'userLoggedIn', userId: '123' }, { requireAck: false });
   *
   * // Wait for ACK (reliable delivery)
   * await peer.notify({ event: 'criticalUpdate', data: {...} });
   * ```
   */
  public notify<T = RpcMessage>(
    payload: T,
    options: { requireAck?: boolean; ackTimeout?: number; transfer?: TransferableItem[] } = {},
  ): Promise<void> {
    // Some transports (server-side ws adapter) swallow sends on a dead socket
    // instead of throwing; without this check the caller would get a misleading
    // "ACK timeout" for a socket that was never connected.
    if (!this.#transport.isConnected) {
      return Promise.reject(new Error('Transport not connected'));
    }

    const requireAck = options.requireAck ?? true;

    // If no ACK required, just send and resolve immediately
    if (!requireAck) {
      const id = crypto.randomUUID();
      try {
        this.#transport.send({ id, type: 'NOTIFY', payload }, options.transfer);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    // If ACK required, wait for it
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const id = crypto.randomUUID();

    const ackTimer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error('ACK timeout - notification not received by peer'));
    }, options.ackTimeout || DEFAULT_ACK_TIMEOUT_MS);

    const task: PendingTask<void> = {
      id,
      payload,
      options: { requireAck, ackTimeout: options.ackTimeout, transfer: options.transfer },
      resolve: resolve as (value: unknown) => void,
      reject,
      ackTimer,
      ackReceived: false,
    };

    this.#pending.set(id, task as PendingTask<unknown>);

    try {
      this.#transport.send({ id, type: 'NOTIFY', payload }, options.transfer);
    } catch (e) {
      clearTimeout(ackTimer);
      this.#pending.delete(id);
      reject(e);
    }

    return promise;
  }

  /**
   * Send a keepalive signal for a long-running operation.
   * This resets the timeout timer on the client side.
   * Call this periodically (e.g., every 5-8 seconds) during long operations.
   *
   * @param requestId - The ID of the request being processed
   * @example
   * ```typescript
   * peer.onMessage(async (payload) => {
   *   if (payload.cmd === 'longOperation') {
   *     const interval = setInterval(() => {
   *       peer.sendKeepalive(payload.requestId);
   *     }, 5000);
   *
   *     try {
   *       const result = await doLongWork();
   *       return result;
   *     } finally {
   *       clearInterval(interval);
   *     }
   *   }
   * });
   * ```
   */
  public sendKeepalive(requestId: string): void {
    try {
      this.#transport.send({ id: requestId, type: 'KEEPALIVE' });
    } catch (e) {
      console.error(`[RpcPeer] Failed to send KEEPALIVE for request ${requestId}:`, e);
    }
  }

  // --- Internal Logic ---

  /** Arm (or re-arm, for KEEPALIVE) the task's single wall-clock deadline. */
  #armDeadline(task: PendingTask<unknown>): void {
    if (task.timer) {
      clearTimeout(task.timer);
    }
    task.timer = setTimeout(() => {
      task.timer = undefined;
      this.#failTask(task, new Error('Timeout waiting for response'));
    }, task.options.timeout || DEFAULT_TIMEOUT_MS);
  }

  /**
   * Send the task's REQ. Re-entrant for ACK retries AND reconnect replays —
   * the packet id is stable across all of them. The transmit cap is enforced
   * here (not only in the ACK timer) so that buffering during a
   * disconnect/reconnect flap can never smuggle a fifth send past the limit.
   */
  #transmit(task: PendingTask<unknown>): void {
    if ((task.attempts ?? 0) >= 1 + MAX_ACK_RETRIES) {
      this.#failTask(task, new Error('Retransmit limit reached - message not received by peer'));
      return;
    }
    this.#pending.set(task.id, task);
    task.attempts = (task.attempts ?? 0) + 1;

    if (task.options.requireAck !== false) {
      this.#armAckTimer(task);
    }

    try {
      this.#transport.send(
        { id: task.id, type: 'REQ', payload: task.payload },
        task.options.transfer,
      );
    } catch (e) {
      this.#failTask(task, toError(e));
    }
  }

  #armAckTimer(task: PendingTask<unknown>): void {
    const ackTimeout = task.options.ackTimeout || DEFAULT_ACK_TIMEOUT_MS;
    task.ackTimer = setTimeout(() => {
      task.ackTimer = undefined;
      if (task.ackReceived || !this.#pending.has(task.id)) {
        return;
      }

      const hint = describePayload(task.payload);
      console.warn(
        `[RpcPeer] ACK timeout for request ${task.id}${hint ? ` (${hint})` : ''} after ${ackTimeout}ms (attempt ${task.attempts})`,
      );

      // Socket died between send and ACK (e.g. Fly VM wake): keep the task for
      // replay on reconnect. The deadline timer stays armed, so a transport
      // that never comes back still fails the task at its own timeout.
      if (!this.#transport.isConnected) {
        if (task.options.retry) {
          this.#pending.delete(task.id);
          this.#buffer.push(task);
        } else {
          this.#failTask(task, new Error('ACK timeout - message not received by peer'));
        }
        return;
      }

      if (!task.options.retry || (task.attempts ?? 1) > MAX_ACK_RETRIES) {
        this.#failTask(task, new Error('ACK timeout - message not received by peer'));
        return;
      }

      console.log(
        `[RpcPeer] Re-sending request ${task.id} after ACK timeout (attempt ${(task.attempts ?? 1) + 1})`,
      );
      this.#pending.delete(task.id);
      this.#transmit(task);
    }, ackTimeout);
  }

  #clearTaskTimers(task: PendingTask<unknown>): void {
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    if (task.ackTimer) {
      clearTimeout(task.ackTimer);
      task.ackTimer = undefined;
    }
  }

  /** Remove the task from wherever it lives (pending or buffer) and reject. */
  #failTask(task: PendingTask<unknown>, error: Error): void {
    this.#clearTaskTimers(task);
    this.#pending.delete(task.id);
    const buffered = this.#buffer.indexOf(task);
    if (buffered >= 0) {
      this.#buffer.splice(buffered, 1);
    }
    task.reject(error);
  }

  #rememberRequest(id: string, res: Packet | null): void {
    this.#recentRequests.set(id, res);
    if (this.#recentRequests.size > RECENT_REQUEST_CACHE_SIZE) {
      const oldest = this.#recentRequests.keys().next().value;
      if (oldest !== undefined) {
        this.#recentRequests.delete(oldest);
      }
    }
  }

  #sendResponse(packet: Packet): void {
    try {
      this.#transport.send(packet);
    } catch (e) {
      console.error(`[RpcPeer] Failed to send response for ${packet.id}:`, e);
    }
  }

  #handleMessage(packet: Packet) {
    // A. Handle Protocol-Level ACK
    if (packet.type === 'ACK') {
      const task = this.#pending.get(packet.id);
      if (task) {
        task.ackReceived = true;
        if (task.ackTimer) {
          clearTimeout(task.ackTimer);
          task.ackTimer = undefined;
        }

        // For NOTIFY packets (no deadline timer), resolve immediately after ACK
        if (!task.timer) {
          this.#pending.delete(packet.id);
          task.resolve(undefined);
        }
      }
      return;
    }

    // B0. Handle PING — respond with PONG (transport-level heartbeat)
    if (packet.type === 'PING') {
      try {
        this.#transport.send({ id: packet.id, type: 'PONG' });
      } catch {
        // Connection dead — onclose will handle it
      }
      return;
    }

    // B0b. Handle PONG — nothing to do, message receipt already tracked by adapter
    if (packet.type === 'PONG') {
      return;
    }

    // B. Handle KEEPALIVE (Long-running operation signal) — re-arms the deadline
    if (packet.type === 'KEEPALIVE') {
      const task = this.#pending.get(packet.id);
      if (task?.timer) {
        this.#armDeadline(task);
      }
      return;
    }

    // C. Handle Response (Application-Level)
    if (packet.type === 'RES') {
      const task = this.#pending.get(packet.id);
      if (task) {
        this.#clearTaskTimers(task);
        this.#pending.delete(packet.id);
        packet.error ? task.reject(new Error(packet.error)) : task.resolve(packet.payload);
      }
      return;
    }

    // D. Handle Request (Incoming)
    if (packet.type === 'REQ') {
      // Immediately send ACK at protocol level
      try {
        this.#transport.send({ id: packet.id, type: 'ACK' });
      } catch (e) {
        console.error(`[RpcPeer] Failed to send ACK for request ${packet.id}:`, e);
      }

      // Duplicate of a request we already saw: the sender's ACK was lost, not
      // the request. Re-ACK happened above; replay the finished RES if we have
      // it, otherwise the original in-flight run will answer. Never re-execute.
      if (this.#recentRequests.has(packet.id)) {
        const cached = this.#recentRequests.get(packet.id);
        console.info(
          `[RpcPeer] Duplicate REQ suppressed: ${packet.id} (${cached ? 'replaying cached RES' : 'original still in flight'})`,
        );
        if (cached) {
          this.#sendResponse(cached);
        }
        return;
      }
      this.#rememberRequest(packet.id, null);

      const handler = this.#handlers.get('MAIN');
      if (!handler) {
        const res: Packet = {
          id: packet.id,
          type: 'RES',
          error: 'No request handler registered on peer',
        };
        this.#rememberRequest(packet.id, res);
        this.#sendResponse(res);
        return;
      }

      // Support both Sync and Async handlers
      let handlerResult: unknown;
      try {
        handlerResult = handler(packet.payload);
      } catch (err) {
        handlerResult = Promise.reject(err);
      }
      Promise.resolve(handlerResult)
        .then(
          (res): Packet => ({ id: packet.id, type: 'RES', payload: res }),
          (err): Packet => ({ id: packet.id, type: 'RES', error: err.message }),
        )
        .then((res) => {
          if (this.#recentRequests.has(packet.id)) {
            this.#recentRequests.set(packet.id, res);
          }
          this.#sendResponse(res);
        });
      return;
    }

    // E. Handle Notification (Incoming)
    if (packet.type === 'NOTIFY') {
      // Immediately send ACK at protocol level
      try {
        this.#transport.send({ id: packet.id, type: 'ACK' });
      } catch (e) {
        console.error(`[RpcPeer] Failed to send ACK for notification ${packet.id}:`, e);
      }

      // Process the notification (no response expected)
      const handler = this.#handlers.get('NOTIFY');
      if (handler) {
        try {
          handler(packet.payload);
        } catch (err) {
          console.error(`[RpcPeer] Error in notification handler:`, err);
        }
      }
      return;
    }
  }

  #flushBuffer() {
    const queue = this.#buffer;
    this.#buffer = [];
    for (const task of queue) {
      this.#transmit(task);
    }
  }

  #recoverTasks() {
    // Retryable in-flight tasks move to the FRONT of the buffer in their
    // original order (they were sent before anything buffered while offline).
    // Their deadline timers stay armed: a transport that never reconnects
    // still fails them at their own timeout instead of hanging forever.
    const recovered: PendingTask<unknown>[] = [];
    this.#pending.forEach((task) => {
      if (task.ackTimer) {
        clearTimeout(task.ackTimer);
        task.ackTimer = undefined;
      }

      if (task.options.retry) {
        recovered.push(task);
      } else {
        if (task.timer) {
          clearTimeout(task.timer);
          task.timer = undefined;
        }
        task.reject(new Error('Connection lost during request'));
      }
    });
    this.#pending.clear();
    this.#buffer = recovered.concat(this.#buffer);
  }
}
