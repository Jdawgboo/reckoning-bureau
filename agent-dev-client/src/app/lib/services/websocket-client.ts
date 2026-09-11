import type {
  ConnectionStatus,
  WebSocketClientOptions,
  SendMessageOptions,
  ContentQueryResult,
  SessionInfo,
  AgentStreamContent,
} from './websocket-client.types';
import {
  AGUI_STREAM_METHOD,
  LOCALE_ACTIVATED_METHOD,
  LOCALE_BUNDLE_READY_METHOD,
  LOCALE_COMMITTED_METHOD,
  LOCALE_HINT_METHOD,
  LOCALE_PROPOSE_METHOD,
  LOCALE_SOURCE_FALLBACK_METHOD,
  STATE_UPDATE_METHOD,
  type AguiFrame,
} from '../../../../../shared/ws-protocol.ts';
import type { LocalizationBundleIdentity } from '../../../../../shared/localization.ts';
import { getWsBaseUrl } from './api-url';
import { AgentAuth } from '../agent-auth';
import { setRpcPeer } from '../trpc';
import { invalidationRegistry } from '../invalidation-registry';
import { RpcPeer, WebSocketAdapter } from '../../../../vendor/agentplace-transport/browser';
import { terminalCloseReason } from './ws-close-policy.ts';

/** Seed delay for the adapter's exponential reconnect backoff. */
const RECONNECT_BASE_DELAY_MS = 1000;

/** Cap for the reconnect backoff — keeps recovery fast for a dev client. */
const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * How often we sample the adapter's connection generation to derive status
 * changes and trigger content resume. The adapter owns the socket lifecycle and
 * exposes `connectionGeneration` (incremented on every successful connect) but
 * no event hook we can subscribe to without stealing RpcPeer's single listener
 * slot — so we poll, mirroring how admin-client's dashboard WS detects reconnects.
 */
const CONNECTION_MONITOR_INTERVAL_MS = 300;

export type LocalizationNotificationMethod =
  | typeof LOCALE_COMMITTED_METHOD
  | typeof LOCALE_BUNDLE_READY_METHOD
  | typeof LOCALE_SOURCE_FALLBACK_METHOD;

/**
 * WebSocket client for communicating with the agent-dev-server.
 *
 * Reconnection, capped backoff, heartbeat (zombie-socket detection) and tab
 * visibility handling are owned by the vendored `WebSocketAdapter` (the browser
 * barrel re-exports the tab-aware `BrowserWebSocketAdapter` under this name). We
 * keep a single long-lived `RpcPeer` over the adapter so its offline buffer
 * replays in-flight requests across reconnects instead of failing them.
 */
export class WebSocketClient {
  #adapter: WebSocketAdapter | null = null;
  #rpcPeer: RpcPeer | null = null;
  #baseUrl?: string;
  #status: ConnectionStatus = 'disconnected';
  #lastContentSeq = 0;

  // Injected dependencies
  #getAgentSessionId: () => string | null;
  #onSessionJoined: (sessionKey: string) => void;

  // Connection monitoring
  #monitorTimer: ReturnType<typeof setInterval> | null = null;
  /** Highest adapter generation we've already reacted to (0 = never connected). */
  #observedGeneration = 0;

  // Content listeners (for direct content streaming)
  #contentListeners = new Set<(content: AgentStreamContent) => void>();
  /** Subscribers to the native AG-UI event stream. Payload is opaque here — the
   *  consumer (e.g. a MessagesStore) interprets the AG-UI event shape. */
  #aguiListeners = new Set<(frame: AguiFrame) => void>();
  #statusListeners = new Set<(status: ConnectionStatus) => void>();
  #errorListeners = new Set<(error: Error) => void>();
  #reconnectListeners = new Set<() => void>();
  #sessionJoinedListeners = new Set<() => void>();
  #localizationListeners = new Set<
    (method: LocalizationNotificationMethod, params: unknown) => void
  >();

  constructor(options: WebSocketClientOptions) {
    this.#getAgentSessionId = options.getAgentSessionId ?? (() => null);
    this.#onSessionJoined = options.onSessionJoined ?? (() => {});
    this.#baseUrl = options.baseUrl;
  }

  #buildUrl(): string {
    const base = this.#baseUrl || getWsBaseUrl();
    const url = new URL('/ws', base);
    // Convert http/https to ws/wss if needed (preserves existing ws/wss)
    if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    }
    // Read agent_session_id from injected callback first, then fall back to URL params
    const agentSessionId =
      this.#getAgentSessionId() ||
      new URLSearchParams(window.location.search).get('agent_session_id');
    if (agentSessionId) {
      url.searchParams.set('agent_session_id', agentSessionId);
    }
    return url.toString();
  }

  // --- Connection Management ---

  /**
   * Set up the connection machinery (adapter + peer) if not already running.
   * Resolves immediately: the adapter connects in the background and the peer
   * buffers any requests issued before the socket opens, replaying them on
   * connect. Actual readiness is observable via `status` / `isConnected` and is
   * what gates callers that await a server round-trip (resume, session info).
   */
  async connect(): Promise<void> {
    if (this.#adapter) {
      return;
    }

    this.#setStatus('connecting');

    // The URL is a factory so `agent_session_id` is re-resolved on every
    // (re)connect attempt rather than frozen at construction time.
    const adapter = new WebSocketAdapter({
      url: () => this.#buildUrl(),
      reconnectDelay: RECONNECT_BASE_DELAY_MS,
      maxReconnectDelay: RECONNECT_MAX_DELAY_MS,
      // maxReconnectAttempts defaults to Infinity — keep trying until the server
      // returns or the client is torn down via disconnect()/auth failure.
      beforeReconnect: (event) => this.#handleBeforeReconnect(event),
    });
    this.#adapter = adapter;

    const peer = new RpcPeer(adapter);
    this.#rpcPeer = peer;
    setRpcPeer(peer);
    peer.onNotify<{ method: string; params: unknown }>((p) => this.#routeNotification(p));

    this.#startMonitor();
  }

  disconnect(): void {
    console.log('[WebSocketClient] Disconnecting...');
    this.#stopMonitor();
    this.#adapter?.close();
    this.#adapter = null;
    this.#rpcPeer = null;
    setRpcPeer(null);
    this.#observedGeneration = 0;
    this.#setStatus('disconnected');
  }

  /**
   * Stop reconnecting on a close code that retrying cannot fix. The adapter
   * reconnects on every close code by default; closing it from this hook flips
   * its internal reconnect flag so the in-progress attempt is abandoned after the
   * hook resolves. See `ws-close-policy.ts` for which codes qualify and why.
   */
  #handleBeforeReconnect(event: CloseEvent | null): void {
    const reason = terminalCloseReason(event?.code);
    if (!reason) {
      return;
    }
    console.log(`[WebSocketClient] Close code ${event?.code} cannot be retried, not reconnecting`);
    this.#stopMonitor();
    this.#adapter?.close();
    this.#setStatus('disconnected');
    this.#notifyError(new Error(reason));
  }

  // --- Connection Monitoring ---

  #startMonitor(): void {
    if (this.#monitorTimer) {
      return;
    }
    this.#monitorTimer = setInterval(() => this.#pollConnection(), CONNECTION_MONITOR_INTERVAL_MS);
  }

  #stopMonitor(): void {
    if (this.#monitorTimer) {
      clearInterval(this.#monitorTimer);
      this.#monitorTimer = null;
    }
  }

  #pollConnection(): void {
    const adapter = this.#adapter;
    if (!adapter) {
      return;
    }

    if (adapter.isConnected) {
      const generation = adapter.connectionGeneration;
      if (generation !== this.#observedGeneration) {
        const isReconnect = this.#observedGeneration > 0;
        this.#observedGeneration = generation;
        this.#setStatus('connected');
        if (isReconnect) {
          this.#handleReconnected();
        }
      } else if (this.#status !== 'connected') {
        this.#setStatus('connected');
      }
      return;
    }

    // Socket is down — distinguish "still establishing the first connection"
    // from "dropped after having been connected".
    if (this.#status === 'connected' || this.#status === 'connecting') {
      this.#setStatus(this.#observedGeneration > 0 ? 'reconnecting' : 'connecting');
    }
  }

  /**
   * After a reconnect, invalidate live queries and notify listeners so the
   * conversation and live data are restored. Listeners own the actual content
   * re-fetch (via `queryContent`) — the client only signals that a reconnect
   * happened, matching how subscribers resume after a drop.
   */
  #handleReconnected(): void {
    // Invalidate all live queries after reconnect — data may have changed while offline
    invalidationRegistry.notifyAll();
    for (const listener of this.#reconnectListeners) {
      listener();
    }
  }

  #routeNotification(p: { method: string; params: unknown }): void {
    switch (p.method) {
      case 'content':
        this.#handleContent(p.params as AgentStreamContent);
        break;
      case AGUI_STREAM_METHOD:
        for (const listener of this.#aguiListeners) {
          listener(p.params as AguiFrame);
        }
        break;
      case 'session.joined': {
        console.log('[WebSocketClient] Session joined:', p.params);
        const params = p.params as { sessionKey?: string };
        if (params?.sessionKey) {
          this.#onSessionJoined(params.sessionKey);
          for (const listener of this.#sessionJoinedListeners) {
            listener();
          }
        }
        break;
      }
      case LOCALE_COMMITTED_METHOD:
      case LOCALE_BUNDLE_READY_METHOD:
      case LOCALE_SOURCE_FALLBACK_METHOD:
        for (const listener of this.#localizationListeners) {
          listener(p.method, p.params);
        }
        break;
      case 'message.started':
        console.log('[WebSocketClient] Queued message started:', p.params);
        break;
      case 'message.error':
        console.error('[WebSocketClient] Message error:', p.params);
        break;
      case 'data.invalidate': {
        const { topic } = p.params as { topic: string };
        invalidationRegistry.notify(topic);
        break;
      }
      case 'error':
        this.#notifyError(new Error(this.#extractErrorMessage(p.params)));
        break;
      default:
        console.log('[WebSocketClient] Unknown notification:', p.method);
    }
  }

  #extractErrorMessage(params: unknown): string {
    if (typeof params === 'object' && params !== null && 'message' in params) {
      const message = (params as { message: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }
    return 'Unknown error';
  }

  // --- Content Handling ---

  #handleContent(content: AgentStreamContent): void {
    // Notify listeners
    for (const listener of this.#contentListeners) {
      try {
        listener(content);
      } catch (error) {
        console.error('[WebSocketClient] Content listener error:', error);
      }
    }
  }

  // --- RPC API ---

  async sendMessage(
    content: string,
    options?: SendMessageOptions,
  ): Promise<{ accepted?: boolean; queued?: boolean; responseId?: string }> {
    const peer = this.#requirePeer();
    return peer.ask(
      {
        method: 'message.send',
        content,
        files: options?.files,
        instruction: options?.instruction,
        memoryBank: options?.memoryBank,
        metadata: options?.metadata,
        hidden: options?.hidden,
        presentation: options?.presentation,
      },
      // Fly VMs can take several seconds to warm up on first request after suspend;
      // default ackTimeout (2s) is too aggressive and caused "ACK not received" with
      // no retry. Enable explicit retry so the request is replayed on reconnect.
      { timeout: 30000, ackTimeout: 15000, retry: true },
    );
  }

  /**
   * Query committed content since afterSeq via the unified content.query protocol.
   */
  async queryContent(afterSeq: number): Promise<ContentQueryResult> {
    const peer = this.#requirePeer();
    const result = await peer.ask<ContentQueryResult>(
      {
        method: 'content.query',
        afterSeq,
      },
      { ackTimeout: 15000, retry: true },
    );
    // Update cursor to highest seq returned
    for (const item of result.items) {
      if (item.seq > this.#lastContentSeq) {
        this.#lastContentSeq = item.seq;
      }
    }
    return result;
  }

  /**
   * Push the client's full `uiState` document via the unified state.update
   * protocol (latest-wins full replace; the server echoes the result to all
   * tabs as an AG-UI STATE_SNAPSHOT).
   */
  async stateUpdate(value: Record<string, unknown>): Promise<{ accepted: boolean }> {
    const peer = this.#requirePeer();
    return peer.ask<{ accepted: boolean }>(
      {
        method: STATE_UPDATE_METHOD,
        value,
      },
      { ackTimeout: 15000, retry: true },
    );
  }

  async localeHint(locale: string, activeBundle?: LocalizationBundleIdentity): Promise<unknown> {
    return this.#requirePeer().ask({
      method: LOCALE_HINT_METHOD,
      locale,
      ...(activeBundle ? { activeBundle } : {}),
    });
  }

  async proposeLocale(locale: string): Promise<unknown> {
    return this.#requirePeer().ask({ method: LOCALE_PROPOSE_METHOD, locale });
  }

  async activateLocale(identity: LocalizationBundleIdentity): Promise<{ accepted: boolean }> {
    return this.#requirePeer().ask({ method: LOCALE_ACTIVATED_METHOD, ...identity });
  }

  async getSessionInfo(): Promise<SessionInfo> {
    const peer = this.#requirePeer();
    return peer.ask<SessionInfo>({ method: 'session.info' });
  }

  /**
   * Abort an active stream by responseId.
   * Best-effort: silently ignores failures (e.g. stream already finished).
   */
  async abortStream(responseId: string): Promise<{ aborted: boolean }> {
    const peer = this.#requirePeer();
    return peer.ask<{ aborted: boolean }>({ method: 'message.abort', responseId });
  }

  #requirePeer(): RpcPeer {
    if (!this.#rpcPeer) {
      throw new Error('Not connected');
    }
    return this.#rpcPeer;
  }

  // --- Content Subscription ---

  /**
   * Subscribe to content messages.
   */
  /** Subscribe to the native AG-UI event stream (the seam MessagesStore
   *  consumes). Frames carry the platform `responseId`; the AG-UI event itself
   *  is opaque here — the consumer interprets it. */
  onAgui(listener: (frame: AguiFrame) => void): () => void {
    this.#aguiListeners.add(listener);
    return () => this.#aguiListeners.delete(listener);
  }

  onContent(listener: (content: AgentStreamContent) => void): () => void {
    this.#contentListeners.add(listener);
    return () => this.#contentListeners.delete(listener);
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    // Immediately notify of current status
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  onSessionJoined(listener: () => void): () => void {
    this.#sessionJoinedListeners.add(listener);
    return () => this.#sessionJoinedListeners.delete(listener);
  }

  onLocalization(
    listener: (method: LocalizationNotificationMethod, params: unknown) => void,
  ): () => void {
    this.#localizationListeners.add(listener);
    return () => this.#localizationListeners.delete(listener);
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#notifyStatusChange();
  }

  #notifyStatusChange(): void {
    for (const listener of this.#statusListeners) {
      try {
        listener(this.#status);
      } catch (error) {
        console.error('[WebSocketClient] Status listener error:', error);
      }
    }
  }

  #notifyError(error: Error): void {
    for (const listener of this.#errorListeners) {
      try {
        listener(error);
      } catch (err) {
        console.error('[WebSocketClient] Error listener error:', err);
      }
    }
  }

  // --- Getters ---

  get status(): ConnectionStatus {
    return this.#status;
  }

  get lastContentSeq(): number {
    return this.#lastContentSeq;
  }

  get isConnected(): boolean {
    return this.#adapter?.isConnected ?? false;
  }
}

/**
 * Create a WebSocket client wired to AgentAuth for session tracking.
 * This is the only place that imports AgentAuth — the WebSocketClient class itself
 * is decoupled and receives dependencies via constructor options.
 */
export function createWebSocketClient(): WebSocketClient {
  return new WebSocketClient({
    getAgentSessionId: () => AgentAuth.agentSessionId,
    onSessionJoined: (key: string) => AgentAuth.setSessionId(key),
  });
}
