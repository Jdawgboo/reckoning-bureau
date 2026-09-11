import { AgentStreamSession } from '../../../../vendor/agent-library/ui/agent-stream-session.ts';
import type { StreamState } from '../../../../vendor/agent-library/ui/agent-stream-session.ts';
import type { IStreamingStore } from '../../../../vendor/agent-library/ui/streaming-store.ts';
import type { IWebSocketManager } from '../services/websocket-manager.ts';

/**
 * Manages streaming lifecycle for a deployed agent session.
 * Parallels BuilderStreamSession on the builder side.
 *
 * Plain class — no MobX, no singletons. Fully testable via constructor injection.
 * MessagesStore creates one instance of this and delegates all stream lifecycle work.
 */
export class AgentStreamController {
  readonly #messaging: IStreamingStore;
  readonly #ws: IWebSocketManager;
  readonly #session: AgentStreamSession;
  #activeResponseId: string | null = null;
  #pendingResolve: (() => void) | null = null;
  #pendingReject: ((e: Error) => void) | null = null;

  constructor(
    messaging: IStreamingStore,
    ws: IWebSocketManager,
    options?: {
      baseDelayMs?: number;
      maxAttempts?: number;
      /** Called after all reconnect attempts exhaust (no pending promise or initializeSession path). */
      onExhausted?: (error: Error) => void;
    },
  ) {
    this.#messaging = messaging;
    this.#ws = ws;
    this.#session = new AgentStreamSession({
      onResume: () => this.#resume(),
      onExhausted: (error) => {
        this.#rejectPending(error);
        options?.onExhausted?.(error);
      },
      baseDelayMs: options?.baseDelayMs ?? 500,
      maxAttempts: options?.maxAttempts ?? 5,
    });
  }

  get state(): StreamState {
    return this.#session.state;
  }

  /** True if a caller is awaiting stream completion. */
  get hasPending(): boolean {
    return this.#pendingResolve !== null;
  }

  /** The responseId of the active stream, or null. Used by MessagesStore.abortCurrentRequest. */
  get activeResponseId(): string | null {
    return this.#activeResponseId;
  }

  /**
   * Capture resolve/reject for the current send call.
   * Returns the awaitable completion promise.
   * The side effect (capturing callbacks) is in the name.
   */
  beginRequest(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#pendingResolve = resolve;
      this.#pendingReject = reject;
    });
  }

  /**
   * Call after the WS send succeeds — sets responseId and marks FSM as streaming.
   * Pass null for the welcome-message path (no responseId from server).
   */
  trackStream(responseId: string | null): void {
    this.#activeResponseId = responseId;
    this.#session.streamStarted();
  }

  /**
   * Mark FSM as streaming without capturing a pending promise.
   * Used by the initializeSession processing branch: the server is already streaming
   * but no caller is awaiting completion (fire-and-forget track).
   */
  trackStreamOnly(): void {
    this.#session.streamStarted();
  }

  /**
   * Handle a finish or error content event from handleSystemContent.
   *
   * Returns true  — event was non-stale; caller should update UI state.
   * Returns false — event was stale; caller drops it silently.
   */
  handleTerminal(
    type: 'finish' | 'error',
    responseId: string | undefined,
    error?: string,
  ): boolean {
    // Stale: we have a known responseId but this event belongs to a different stream.
    if (this.#activeResponseId && responseId && responseId !== this.#activeResponseId) {
      return false;
    }
    // Pre-correlation: event arrived before trackStream was called; ignore until correlated.
    if (!this.#activeResponseId && this.#pendingResolve !== null && responseId) {
      return false;
    }
    if (type === 'finish') {
      this.#resolvePending();
    } else {
      this.#rejectPending(new Error(error ?? 'Unknown error'));
    }
    this.#session.reset();
    return true;
  }

  /**
   * Trigger FSM disconnect + retry loop.
   * Call from the MessagesStore onReconnect handler when a stream is active.
   */
  notifyDisconnected(): void {
    if (
      this.#session.state === 'streaming' ||
      this.#session.state === 'paused' ||
      this.#session.state === 'resuming'
    ) {
      this.#session.disconnected();
    }
  }

  /**
   * Resolve the pending request (no stale check needed — called from onReconnect
   * idle branch where we've already confirmed the server is idle).
   * Returns true if there was a pending request, false otherwise.
   */
  resolvePendingIfActive(): boolean {
    if (this.#pendingResolve === null) {
      return false;
    }
    this.#resolvePending();
    return true;
  }

  /** Abort the ongoing stream and reject any pending caller. */
  abort(): void {
    this.#session.abort();
    this.#rejectPending(
      Object.assign(new Error('Request was cancelled'), { name: 'CanceledError' }),
    );
  }

  /**
   * Clear pending request state without rejecting.
   * Call from send-method catch blocks when the HTTP/WS call failed before
   * streamStarted() — the promise is still pending but nobody will await it.
   * Silently abandons the promise (no unhandled rejection since no reject is called).
   */
  cancelRequest(): void {
    this.#clear();
  }

  cleanup(): void {
    this.#session.cleanup();
    this.#clear();
  }

  /**
   * Resume callback — called by AgentStreamSession on each reconnect attempt.
   * Restores the full committed set (querying from 0), never a delta: the
   * deployed agent does not paginate, so a wholesale `restore` is correct and
   * matches `initializeSession`. A delta + wholesale `restore` would collapse the
   * conversation to just the tail.
   */
  async #resume(): Promise<'streaming' | 'complete'> {
    const result = await this.#ws.queryContent(0);
    this.#messaging.clearStreamingMessages('agent');
    this.#messaging.restore(
      'agent',
      result.items.map((i) => i.content),
    );
    if (result.streamStatus === 'complete') {
      this.#resolvePending();
      return 'complete';
    }
    return 'streaming';
  }

  #resolvePending(): void {
    const resolve = this.#pendingResolve;
    this.#activeResponseId = null;
    this.#pendingResolve = null;
    this.#pendingReject = null;
    resolve?.();
  }

  #rejectPending(error: Error): void {
    const reject = this.#pendingReject;
    this.#activeResponseId = null;
    this.#pendingResolve = null;
    this.#pendingReject = null;
    reject?.(error);
  }

  #clear(): void {
    this.#activeResponseId = null;
    this.#pendingResolve = null;
    this.#pendingReject = null;
  }
}
