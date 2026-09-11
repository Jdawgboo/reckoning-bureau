import { isRecord } from '../util/type-guards.ts';

const SESSION_ID_STORAGE_KEY = 'agentplace_session_id';
const DEV_RELOAD_FLAG_KEY = 'agentplace_dev_reload';

/**
 * True when the browser killed this tab in the background and restored it
 * (mobile app-switch eviction). Chromium-only signal; browsers without
 * `document.wasDiscarded` always report false.
 */
function wasTabDiscarded(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const doc: unknown = document;
  return isRecord(doc) && doc.wasDiscarded === true;
}

/**
 * `crypto.randomUUID` is secure-context-only; testing the template from a
 * phone against a LAN IP (http://192.168.x.x) must not crash.
 */
function mintSessionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const versioned = bytes.map((byte, index) => {
    if (index === 6) {
      return (byte & 0x0f) | 0x40;
    }
    if (index === 8) {
      return (byte & 0x3f) | 0x80;
    }
    return byte;
  });
  const hex = versioned.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SessionStateOptions {
  initialSessionId?: string | null;
}

/**
 * Session identity resolution. Two modes:
 * - Platform-controlled: `?agent_session_id` in the URL (dashboard preview
 *   iframes, present-agent embeds) — sticky, rotation owned by the dashboard.
 * - Visitor: no URL param — every page load mints a fresh session ID, so a
 *   manual reload always starts a new conversation. Two continuity
 *   exceptions resume the sessionStorage stash: a discarded-tab restore
 *   (mobile app-switch) and a programmatic dev reload (one-shot flag set by
 *   the hot-reload listener before it reloads the page).
 */
export class SessionState {
  #agentSessionId: string | null;

  constructor(options: SessionStateOptions) {
    this.#agentSessionId = options.initialSessionId ?? null;
    if (this.#agentSessionId) {
      this.#persistSessionId(this.#agentSessionId);
    }
  }

  static resolveInitialSessionId(opts: { explicit?: string | null }): string {
    SessionState.#removeLegacyPersistedSessionId();
    const isDevReload = SessionState.#consumeDevReloadFlag();

    if (opts.explicit) {
      return opts.explicit;
    }

    if (typeof window !== 'undefined') {
      const urlSessionId = new URLSearchParams(window.location.search).get('agent_session_id');
      if (urlSessionId) {
        return urlSessionId;
      }
    }

    if (isDevReload || wasTabDiscarded()) {
      const stashed = SessionState.#readStashedSessionId();
      if (stashed) {
        return stashed;
      }
    }

    return mintSessionId();
  }

  /** Call immediately before a programmatic reload (dev hot-reload) to keep the session. */
  static markDevReload(): void {
    try {
      sessionStorage.setItem(DEV_RELOAD_FLAG_KEY, '1');
    } catch {
      // ignore
    }
  }

  get agentSessionId(): string | null {
    return this.#agentSessionId;
  }

  setSessionId(sessionId: string): void {
    this.#agentSessionId = sessionId;
    this.#persistSessionId(sessionId);
  }

  maybeUpdateFromResponse(response: Response): boolean {
    const sessionId = response.headers.get('X-Agentplace-Session-Id');
    if (sessionId && sessionId !== this.#agentSessionId) {
      console.warn(
        `[SessionState] Server returned different session ID: ${sessionId} (was: ${this.#agentSessionId}). ` +
          `This may indicate a session ID injection issue.`,
      );
      this.setSessionId(sessionId);
      return true;
    }
    return false;
  }

  #persistSessionId(sessionId: string): void {
    try {
      sessionStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);
    } catch {
      // ignore
    }
  }

  static #readStashedSessionId(): string | null {
    try {
      return sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /** Consumed (cleared) on every resolution so the flag can never go stale. */
  static #consumeDevReloadFlag(): boolean {
    try {
      const present = sessionStorage.getItem(DEV_RELOAD_FLAG_KEY) !== null;
      sessionStorage.removeItem(DEV_RELOAD_FLAG_KEY);
      return present;
    } catch {
      return false;
    }
  }

  /** Sessions used to persist in localStorage (cross-tab, indefinitely); drop the stale key. */
  static #removeLegacyPersistedSessionId(): void {
    try {
      localStorage.removeItem(SESSION_ID_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
