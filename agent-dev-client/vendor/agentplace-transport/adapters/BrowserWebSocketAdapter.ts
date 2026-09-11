import { WebSocketAdapter } from './WebSocketAdapter.ts';

/**
 * Browser-aware WebSocket adapter.
 *
 * Extends `WebSocketAdapter` with tab visibility handling. Browsers throttle
 * `setInterval`/`setTimeout` in hidden tabs (often to ~1/min), which breaks the
 * base heartbeat's "large silence means dead peer" heuristic — a throttled tick
 * observes a large silence purely because the timer was sleeping. Left unhandled,
 * this causes an infinite disconnect/reconnect loop on any backgrounded tab.
 *
 * Strategy:
 * - While the tab is hidden, skip staleness evaluation entirely. Real socket
 *   deaths still surface via `onclose` — the browser delivers that regardless.
 * - When the tab becomes visible again, re-prime the heartbeat clock and send
 *   a verification PING so a genuinely dead connection is detected within the
 *   normal probe window, just from the moment the tab can actually observe.
 */
export class BrowserWebSocketAdapter extends WebSocketAdapter {
  protected override _installEnvironmentHooks(): () => void {
    if (typeof document === 'undefined') {
      return () => {};
    }

    const onVisibilityChange = () => {
      this._logger.log?.('[BrowserWebSocketAdapter] visibilitychange', {
        visibilityState: document.visibilityState,
        isConnected: this.isConnected,
      });
      if (!document.hidden) {
        this._primeHeartbeat();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  protected override _shouldSkipHeartbeatCheck(): boolean {
    return typeof document !== 'undefined' && document.hidden;
  }
}
