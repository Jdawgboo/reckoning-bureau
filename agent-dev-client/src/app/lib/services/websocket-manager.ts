/**
 * WebSocket Manager
 *
 * Manages a single WebSocket connection for the entire application.
 * Handles message sending/receiving, connection lifecycle, and content distribution.
 */

import {
  createWebSocketClient,
  type LocalizationNotificationMethod,
  type WebSocketClient,
} from './websocket-client';
import type {
  ConnectionStatus,
  ContentQueryResult,
  SendMessageOptions,
  SessionInfo,
  AgentStreamContent,
} from './websocket-client.types';
import type { AguiFrame } from '../../../../../shared/ws-protocol.ts';
import type { LocalizationBundleIdentity } from '../../../../../shared/localization.ts';

export type ContentHandler = (content: AgentStreamContent) => void;
export type AguiHandler = (frame: AguiFrame) => void;
export type StatusHandler = (status: ConnectionStatus) => void;
export type ErrorHandler = (error: Error) => void;
export type ReconnectHandler = () => void;
export type SessionJoinedHandler = () => void;
export type LocalizationHandler = (method: LocalizationNotificationMethod, params: unknown) => void;

export type WebSocketManagerSendOptions = Omit<SendMessageOptions, 'instruction'>;

/**
 * Minimal WS manager interface for constructor injection into AgentStreamController.
 * WebSocketManager (the singleton) satisfies this interface.
 */
export interface IWebSocketManager {
  queryContent(afterSeq: number): Promise<ContentQueryResult>;
  abortStream(responseId: string): Promise<{ aborted: boolean }>;
  getSessionInfo(): Promise<{ status: string }>;
  onReconnect(handler: () => void): () => void;
}

class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private client: WebSocketClient | null = null;

  // Handlers for direct content streaming
  private contentHandlers = new Set<ContentHandler>();
  // Handlers for the native AG-UI event stream
  private aguiHandlers = new Set<AguiHandler>();
  // Connection status handlers
  private statusHandlers = new Set<StatusHandler>();
  // Error handlers
  private errorHandlers = new Set<ErrorHandler>();
  // Reconnect handlers
  private reconnectHandlers = new Set<ReconnectHandler>();
  private sessionJoinedHandlers = new Set<SessionJoinedHandler>();
  private localizationHandlers = new Set<LocalizationHandler>();

  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  /**
   * Initialize and connect to WebSocket server.
   * Idempotent - multiple calls return the same promise.
   */
  async connect(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doConnect();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    console.log('[WebSocketManager] Connecting...');

    this.client = createWebSocketClient();

    // Subscribe to content (direct content streaming)
    this.client.onContent(this.handleContent.bind(this));
    this.client.onAgui(this.handleAgui.bind(this));
    this.client.onStatusChange(this.handleStatusChange.bind(this));
    this.client.onError(this.handleError.bind(this));
    this.client.onReconnect(this.handleReconnect.bind(this));
    this.client.onSessionJoined(this.handleSessionJoined.bind(this));
    this.client.onLocalization(this.handleLocalization.bind(this));

    await this.client.connect();
    this.isInitialized = true;
    console.log('[WebSocketManager] Connected');
  }

  /**
   * Query committed content from server since afterSeq.
   */
  async queryContent(afterSeq: number): Promise<ContentQueryResult> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.queryContent(afterSeq);
  }

  /**
   * Push the client's full `uiState` document to the server.
   */
  async stateUpdate(value: Record<string, unknown>): Promise<{ accepted: boolean }> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.stateUpdate(value);
  }

  /**
   * Get current session info from server.
   */
  async getSessionInfo(): Promise<SessionInfo> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.getSessionInfo();
  }

  /**
   * Handle direct content messages from WebSocket.
   */
  private handleContent(content: AgentStreamContent): void {
    for (const handler of this.contentHandlers) {
      try {
        handler(content);
      } catch (error) {
        console.error('[WebSocketManager] Content handler error:', error);
      }
    }
  }

  private handleAgui(frame: AguiFrame): void {
    for (const handler of this.aguiHandlers) {
      try {
        handler(frame);
      } catch (error) {
        console.error('[WebSocketManager] AG-UI handler error:', error);
      }
    }
  }

  private handleStatusChange(status: ConnectionStatus): void {
    console.log('[WebSocketManager] Status changed:', status);
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (error) {
        console.error('[WebSocketManager] Status handler error:', error);
      }
    }
  }

  private handleError(error: Error): void {
    console.error('[WebSocketManager] Error:', error);
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error('[WebSocketManager] Error handler error:', err);
      }
    }
  }

  private handleReconnect(): void {
    console.log('[WebSocketManager] Reconnected');
    for (const handler of this.reconnectHandlers) {
      try {
        handler();
      } catch (error) {
        console.error('[WebSocketManager] reconnect handler threw', error);
      }
    }
  }

  private handleSessionJoined(): void {
    for (const handler of this.sessionJoinedHandlers) {
      handler();
    }
  }

  private handleLocalization(method: LocalizationNotificationMethod, params: unknown): void {
    for (const handler of this.localizationHandlers) {
      handler(method, params);
    }
  }

  /**
   * Subscribe to direct AgentContent messages.
   * Returns an unsubscribe function.
   */
  onContent(handler: ContentHandler): () => void {
    this.contentHandlers.add(handler);
    return () => this.contentHandlers.delete(handler);
  }

  /**
   * Subscribe to the native AG-UI event stream (frames carry the platform
   * `responseId`). Returns an unsubscribe function.
   */
  onAgui(handler: AguiHandler): () => void {
    this.aguiHandlers.add(handler);
    return () => this.aguiHandlers.delete(handler);
  }

  /**
   * Subscribe to connection status changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /**
   * Subscribe to errors.
   * Returns an unsubscribe function.
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Subscribe to reconnect events.
   * Called after a successful reconnect.
   * Returns an unsubscribe function.
   */
  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  onSessionJoined(handler: SessionJoinedHandler): () => void {
    this.sessionJoinedHandlers.add(handler);
    return () => this.sessionJoinedHandlers.delete(handler);
  }

  onLocalization(handler: LocalizationHandler): () => void {
    this.localizationHandlers.add(handler);
    return () => this.localizationHandlers.delete(handler);
  }

  /**
   * Send a message to the server.
   * Returns the server response including responseId for abort correlation.
   */
  async sendMessage(
    content: string,
    options?: WebSocketManagerSendOptions,
  ): Promise<{ accepted?: boolean; queued?: boolean; responseId?: string }> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }

    return this.client.sendMessage(content, {
      files: options?.files,
      memoryBank: options?.memoryBank,
      metadata: options?.metadata,
      hidden: options?.hidden,
      presentation: options?.presentation,
    });
  }

  async sendMessageForQuery(
    content: string,
    options?: WebSocketManagerSendOptions,
  ): Promise<{ responseId: string; queued: boolean }> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }

    const result = await this.client.sendMessage(content, {
      files: options?.files,
      memoryBank: options?.memoryBank,
      metadata: options?.metadata,
      hidden: options?.hidden,
      presentation: options?.presentation,
    });

    const responseId = result?.responseId;
    if (typeof responseId !== 'string' || !responseId) {
      throw new Error('Server did not return responseId');
    }

    return { responseId, queued: Boolean(result.queued) };
  }

  async localeHint(locale: string, activeBundle?: LocalizationBundleIdentity): Promise<unknown> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.localeHint(locale, activeBundle);
  }

  async proposeLocale(locale: string): Promise<unknown> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.proposeLocale(locale);
  }

  async activateLocale(identity: LocalizationBundleIdentity): Promise<{ accepted: boolean }> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.activateLocale(identity);
  }

  /**
   * Abort an active stream by responseId.
   * Best-effort: errors are silently caught by the caller.
   */
  async abortStream(responseId: string): Promise<{ aborted: boolean }> {
    if (!this.client) {
      throw new Error('WebSocket not connected');
    }
    return this.client.abortStream(responseId);
  }

  /**
   * Disconnect from WebSocket server.
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.isInitialized = false;
    console.log('[WebSocketManager] Disconnected');
  }

  /**
   * Get current connection status.
   */
  get status(): ConnectionStatus {
    return this.client?.status || 'disconnected';
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this.client?.isConnected || false;
  }
}

// Export singleton instance
export const wsManager = WebSocketManager.getInstance();
