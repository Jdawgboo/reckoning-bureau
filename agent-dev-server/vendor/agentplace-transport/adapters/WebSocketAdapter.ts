import type { ITransport, TransportEvent } from '../Transport';
import type { Packet, TransferableItem } from '../types';

export interface WebSocketAdapterOptions {
  /** WebSocket URL — static string or factory invoked on every (re)connect attempt. */
  url: string | (() => string);
  /**
   * Base reconnection delay in ms. Used as the seed for exponential backoff:
   * actual delay = min(reconnectDelay * 2 ** attempts, maxReconnectDelay).
   * @default 1000
   */
  reconnectDelay?: number;
  /**
   * Maximum reconnection delay in ms (cap for exponential backoff).
   * @default 60000 (1 minute)
   */
  maxReconnectDelay?: number;
  /** Maximum reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
  /** WebSocket protocols (optional) */
  protocols?: string | string[];
  /**
   * Optional hook invoked after a disconnect and before scheduling a reconnect.
   * Useful for refreshing auth tokens on specific close codes.
   * The hook is awaited — it can delay reconnection.
   */
  beforeReconnect?: (event: CloseEvent | null) => void | Promise<void>;
  /** Optional logger (defaults to console) */
  logger?: {
    log?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /**
   * Enable application-level heartbeat to detect dead connections.
   * Sends a NOTIFY probe; the peer's RpcPeer auto-ACKs it, confirming liveness.
   * Essential for detecting zombie TCP sockets after suspend/resume or network drops.
   * @default true
   */
  heartbeat?: boolean;
  /**
   * How often to check connection liveness, in ms.
   * If no message received for this duration, a probe is sent.
   * @default 15000 (15 seconds)
   */
  heartbeatInterval?: number;
  /**
   * How long to wait for any response after sending a probe, in ms.
   * If still silent after this window, the connection is force-closed.
   * @default 5000 (5 seconds)
   */
  heartbeatTimeout?: number;
}

/**
 * WebSocket adapter for RpcPeer.
 * Provides automatic reconnection, optional URL refresh, and lifecycle management.
 *
 * Environment-agnostic — runs unchanged in Node and browser. Environment-specific
 * behavior (e.g. browser tab visibility handling) is added by subclasses via the
 * protected hooks `_installEnvironmentHooks`, `_shouldSkipHeartbeatCheck`, and
 * `_primeHeartbeat`. For browsers, use `BrowserWebSocketAdapter` from this package.
 */
export class WebSocketAdapter implements ITransport {
  #ws: WebSocket | null = null;
  #listeners: Record<string, Function> = {};
  #reconnectAttempts = 0;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #reconnectTask: Promise<void> | null = null;
  #shouldReconnect = true;
  #options: WebSocketAdapterOptions;
  #connectionGeneration = 0;
  protected readonly _logger: NonNullable<WebSocketAdapterOptions['logger']>;

  // Heartbeat state
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #probeTimer?: ReturnType<typeof setTimeout>;
  #lastMessageAt = 0;
  #environmentCleanup?: () => void;

  public get isConnected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Increments on every successful connection. Use to detect reconnections. */
  public get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  constructor(options: WebSocketAdapterOptions) {
    this.#options = options;
    this._logger = options.logger ?? console;
    this.#connect();
  }

  public send(packet: Packet, _transfer?: TransferableItem[]) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(packet));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  public on(event: TransportEvent, fn: Function) {
    this.#listeners[event] = fn;
  }

  public close() {
    this._logger.log?.('[WebSocketAdapter] close() called');
    this.#shouldReconnect = false;
    this.#stopHeartbeat();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  /**
   * Debug helper: close the underlying socket but keep auto-reconnect enabled.
   * This simulates a transient network drop.
   */
  public debugDisconnect(): void {
    this._logger.log?.('[WebSocketAdapter] debugDisconnect() called');
    this.#shouldReconnect = true;
    if (this.#ws) {
      this.#ws.close();
    } else {
      void this.#attemptReconnect(null);
    }
  }

  // === Protected hooks for environment-specific subclasses ===

  /**
   * Install environment-specific hooks when heartbeat starts. Return a cleanup
   * function that's invoked on stop. Default: no-op. Browser subclass overrides
   * this to listen for `visibilitychange` and re-prime the heartbeat on return.
   */
  protected _installEnvironmentHooks(): () => void {
    return () => {};
  }

  /**
   * Return true to skip the heartbeat staleness check on this tick.
   * Default: never skip. Browser subclass overrides to skip while the tab is
   * hidden, because `setInterval` is throttled there and any observed silence
   * reflects the timer sleeping, not a dead peer.
   */
  protected _shouldSkipHeartbeatCheck(): boolean {
    return false;
  }

  /**
   * Re-prime the heartbeat after a known environment event (e.g. tab becomes
   * visible). Resets the silence clock and sends a PING to verify the socket.
   * Subclasses call this when the environment says "the timer was probably
   * asleep, assume any observed silence is bogus."
   */
  protected _primeHeartbeat(): void {
    if (!this.isConnected) {
      return;
    }
    this.#lastMessageAt = Date.now();
    try {
      this.send({ id: `__hb_prime_${Date.now()}`, type: 'PING' });
    } catch {
      // send() failed — socket is already broken, onclose will handle it
    }
  }

  /**
   * Abandon a dead socket immediately without waiting for the TCP close handshake.
   * The global Node.js WebSocket has no closeTimeout, so ws.close() on a zombie
   * connection gets stuck in TCP retransmission purgatory (~13 min on Linux).
   * This method detaches all handlers, emits disconnect, and starts reconnection.
   */
  #forceTerminate(reason: string): void {
    const deadSocket = this.#ws;
    if (!deadSocket) {
      return;
    }

    this._logger.warn?.(`[WebSocketAdapter] Force-terminating: ${reason}`);

    // Detach handlers so stale events from the abandoned socket are ignored
    deadSocket.onopen = null;
    deadSocket.onmessage = null;
    deadSocket.onerror = null;
    deadSocket.onclose = null;

    // Disown the socket immediately
    this.#ws = null;
    this.#stopHeartbeat();

    // Emit disconnect so RpcPeer can run #recoverTasks()
    this.#listeners.disconnect?.();

    // Best-effort close — fire-and-forget
    try {
      deadSocket.close(4000, reason);
    } catch {}

    // Start reconnection
    void this.#attemptReconnect(null);
  }

  #startHeartbeat(): void {
    if (this.#options.heartbeat === false) {
      return;
    }

    this.#stopHeartbeat();

    const interval = this.#options.heartbeatInterval ?? 15_000;
    const timeout = this.#options.heartbeatTimeout ?? 5_000;

    this.#environmentCleanup = this._installEnvironmentHooks();

    this.#heartbeatTimer = setInterval(
      () => {
        if (!this.isConnected) {
          return;
        }

        if (this._shouldSkipHeartbeatCheck()) {
          return;
        }

        const silenceMs = Date.now() - this.#lastMessageAt;
        if (silenceMs < interval) {
          return; // Recent activity — connection is alive
        }

        // If silence exceeds what's possible under normal operation (interval +
        // 2x timeout), the process was likely suspended
        if (silenceMs >= interval + timeout * 2) {
          this._logger.warn?.(
            `[WebSocketAdapter] Likely suspend/resume detected (${Math.round(silenceMs / 1000)}s silence), force-terminating`,
          );
          this.#forceTerminate('Stale connection after suspend/resume');
          return;
        }

        // No activity for a full interval — send a PING probe
        try {
          this.send({ id: `__hb_${Date.now()}`, type: 'PING' });
        } catch {
          // send() failed — socket is already broken, onclose will handle it
          return;
        }

        // Start a one-shot deadline: if no message arrives within timeout, force-close
        if (!this.#probeTimer) {
          this.#probeTimer = setTimeout(() => {
            this.#probeTimer = undefined;
            if (this._shouldSkipHeartbeatCheck()) {
              return;
            }
            const actualSilenceMs = Date.now() - this.#lastMessageAt;
            if (actualSilenceMs < interval + timeout) {
              return; // A message arrived in time — nothing to do.
            }

            // Distinguish genuine peer silence from a process suspend/resume:
            // if the probe fires far later than scheduled (happens when a VM was
            // paused with this timer armed), call it out explicitly. Without
            // this, the log said "no response within 5000ms" for 10-hour-old
            // sockets, which made Fly wake-up diagnostics very confusing.
            if (actualSilenceMs >= interval + timeout * 2) {
              this._logger.warn?.(
                `[WebSocketAdapter] Probe fired after ${Math.round(
                  actualSilenceMs / 1000,
                )}s silence — likely suspend/resume, force-terminating`,
              );
              this.#forceTerminate('Stale connection after suspend/resume');
              return;
            }

            this._logger.warn?.(
              `[WebSocketAdapter] Connection dead — no response for ${actualSilenceMs}ms (probe timeout ${timeout}ms), forcing close`,
            );
            this.#forceTerminate('Heartbeat timeout');
          }, timeout);
        }
      },
      Math.min(interval, 5_000),
    ); // Check frequently, but only probe when idle
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#clearProbeTimer();
    this.#environmentCleanup?.();
    this.#environmentCleanup = undefined;
  }

  #clearProbeTimer(): void {
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  #resolveUrl(): string {
    const { url } = this.#options;
    return typeof url === 'function' ? url() : url;
  }

  #connect() {
    try {
      const url = this.#resolveUrl();
      this.#ws = new WebSocket(url, this.#options.protocols);

      this.#ws.onopen = () => {
        this._logger.log?.('[WebSocketAdapter] Connected');
        this.#reconnectAttempts = 0;
        this.#connectionGeneration++;
        this.#lastMessageAt = Date.now();
        this.#startHeartbeat();
        this.#listeners.connect?.();
      };

      this.#ws.onmessage = (event: MessageEvent) => {
        this.#lastMessageAt = Date.now();
        this.#clearProbeTimer();
        try {
          const packet = JSON.parse(event.data);
          this.#listeners.message?.(packet);
        } catch (error) {
          this._logger.error?.('[WebSocketAdapter] Failed to parse message:', error);
        }
      };

      this.#ws.onerror = (error: Event) => {
        this._logger.warn?.('[WebSocketAdapter] Error:', error);
      };

      this.#ws.onclose = (event: CloseEvent) => {
        this.#stopHeartbeat();

        const closeInfo = {
          code: event?.code,
          reason: event.reason || '(none)',
          wasClean: event.wasClean,
        };

        if (event.code !== 1000 && event.code !== 1001) {
          this._logger.warn?.('[WebSocketAdapter] Disconnected abnormally', closeInfo);
        } else {
          this._logger.log?.('[WebSocketAdapter] Disconnected', closeInfo);
        }

        const hadSocket = this.#ws !== null;
        this.#ws = null;

        if (hadSocket) {
          this.#listeners.disconnect?.();
        }

        void this.#attemptReconnect(event);
      };
    } catch (error) {
      this._logger.error?.('[WebSocketAdapter] Failed to create WebSocket:', error);
      void this.#attemptReconnect(null);
    }
  }

  async #attemptReconnect(event: CloseEvent | null): Promise<void> {
    if (!this.#shouldReconnect) {
      return;
    }
    if (this.#reconnectTimer) {
      return;
    }
    if (this.#reconnectTask) {
      return;
    }

    this.#reconnectTask = (async () => {
      try {
        if (this.#options.beforeReconnect) {
          await this.#options.beforeReconnect(event);
        }
      } catch (hookError) {
        this._logger.warn?.('[WebSocketAdapter] beforeReconnect hook failed:', hookError);
      }

      if (!this.#shouldReconnect) {
        return;
      }

      const maxAttempts = this.#options.maxReconnectAttempts ?? Infinity;
      if (this.#reconnectAttempts >= maxAttempts) {
        this._logger.error?.('[WebSocketAdapter] Max reconnection attempts reached');
        return;
      }

      // Exponential backoff prevents single-client reconnect storms from amplifying.
      // 1s, 2s, 4s, 8s, ..., capped at maxReconnectDelay. A misbehaving client (e.g.
      // backgrounded browser tab dropping pongs) can no longer hammer the server at
      // a fixed 2s cadence — observed on 2026-05-09 to produce ~7k events/hour
      // from a single user-agent pair.
      const baseDelay = this.#options.reconnectDelay ?? 1000;
      const maxDelay = this.#options.maxReconnectDelay ?? 60000;
      const delay = Math.min(baseDelay * 2 ** this.#reconnectAttempts, maxDelay);
      this.#reconnectAttempts++;

      this._logger.log?.(
        `[WebSocketAdapter] Reconnecting in ${delay}ms (attempt ${this.#reconnectAttempts}/${maxAttempts === Infinity ? '∞' : maxAttempts})`,
      );

      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = undefined;
        this.#connect();
      }, delay);
    })();

    try {
      await this.#reconnectTask;
    } finally {
      this.#reconnectTask = null;
    }
  }
}
