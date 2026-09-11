import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionState } from './session-state.ts';

const SESSION_ID_STORAGE_KEY = 'agentplace_session_id';
const DEV_RELOAD_FLAG_KEY = 'agentplace_dev_reload';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const GLOBALS = ['window', 'document', 'sessionStorage', 'localStorage'] as const;
const originals = new Map<string, unknown>();

function stubGlobal(name: (typeof GLOBALS)[number], value: unknown): void {
  Reflect.set(globalThis, name, value);
}

function saveGlobals(): void {
  for (const name of GLOBALS) {
    originals.set(name, Reflect.get(globalThis, name));
  }
}

function restoreGlobals(): void {
  for (const name of GLOBALS) {
    Reflect.set(globalThis, name, originals.get(name));
  }
}

describe('SessionState.resolveInitialSessionId', () => {
  beforeEach(() => {
    saveGlobals();
    stubGlobal('window', { location: { search: '' } });
    stubGlobal('document', {});
    stubGlobal('sessionStorage', createStorageStub());
    stubGlobal('localStorage', createStorageStub());
  });

  afterEach(restoreGlobals);

  it('prefers the explicit option over everything else', () => {
    stubGlobal('window', { location: { search: '?agent_session_id=from-url' } });
    const resolved = SessionState.resolveInitialSessionId({ explicit: 'explicit-id' });
    assert.strictEqual(resolved, 'explicit-id');
  });

  it('uses the URL param when present (platform-controlled session)', () => {
    stubGlobal('window', { location: { search: '?agent_session_id=from-url' } });
    const resolved = SessionState.resolveInitialSessionId({});
    assert.strictEqual(resolved, 'from-url');
  });

  it('mints a fresh session id per load for visitors (no URL param)', () => {
    sessionStorage.setItem(SESSION_ID_STORAGE_KEY, 'stashed-id');
    const first = SessionState.resolveInitialSessionId({});
    const second = SessionState.resolveInitialSessionId({});
    assert.match(first, UUID_RE);
    assert.match(second, UUID_RE);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first, 'stashed-id');
  });

  it('resumes the stashed session id after a discarded-tab restore', () => {
    stubGlobal('document', { wasDiscarded: true });
    sessionStorage.setItem(SESSION_ID_STORAGE_KEY, 'stashed-id');
    const resolved = SessionState.resolveInitialSessionId({});
    assert.strictEqual(resolved, 'stashed-id');
  });

  it('mints a fresh id on discarded-tab restore when nothing is stashed', () => {
    stubGlobal('document', { wasDiscarded: true });
    const resolved = SessionState.resolveInitialSessionId({});
    assert.match(resolved, UUID_RE);
  });

  it('resumes the stash after a dev reload, one-shot', () => {
    sessionStorage.setItem(SESSION_ID_STORAGE_KEY, 'stashed-id');
    SessionState.markDevReload();
    const first = SessionState.resolveInitialSessionId({});
    assert.strictEqual(first, 'stashed-id');
    const second = SessionState.resolveInitialSessionId({});
    assert.match(second, UUID_RE);
  });

  it('consumes the dev-reload flag even when the URL param wins', () => {
    stubGlobal('window', { location: { search: '?agent_session_id=from-url' } });
    sessionStorage.setItem(SESSION_ID_STORAGE_KEY, 'stashed-id');
    SessionState.markDevReload();
    const resolved = SessionState.resolveInitialSessionId({});
    assert.strictEqual(resolved, 'from-url');
    assert.strictEqual(sessionStorage.getItem(DEV_RELOAD_FLAG_KEY), null);
  });

  it('mints a fresh id on dev reload when nothing is stashed', () => {
    SessionState.markDevReload();
    const resolved = SessionState.resolveInitialSessionId({});
    assert.match(resolved, UUID_RE);
  });

  it('removes the legacy localStorage session id', () => {
    localStorage.setItem(SESSION_ID_STORAGE_KEY, 'legacy-id');
    SessionState.resolveInitialSessionId({});
    assert.strictEqual(localStorage.getItem(SESSION_ID_STORAGE_KEY), null);
  });

  it('falls back to a getRandomValues-based v4 UUID when crypto.randomUUID is absent', () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    assert.ok(cryptoDescriptor, 'crypto global must exist');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (array: Uint8Array) => {
          array.fill(0xab);
          return array;
        },
      },
    });
    try {
      const resolved = SessionState.resolveInitialSessionId({});
      assert.match(resolved, UUID_RE);
    } finally {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    }
  });
});

describe('SessionState persistence', () => {
  beforeEach(() => {
    saveGlobals();
    stubGlobal('sessionStorage', createStorageStub());
    stubGlobal('localStorage', createStorageStub());
  });

  afterEach(restoreGlobals);

  it('stashes the initial session id to sessionStorage on construction', () => {
    new SessionState({ initialSessionId: 'initial-id' });
    assert.strictEqual(sessionStorage.getItem(SESSION_ID_STORAGE_KEY), 'initial-id');
  });

  it('stashes to sessionStorage, not localStorage, on setSessionId', () => {
    const state = new SessionState({ initialSessionId: null });
    state.setSessionId('joined-id');
    assert.strictEqual(state.agentSessionId, 'joined-id');
    assert.strictEqual(sessionStorage.getItem(SESSION_ID_STORAGE_KEY), 'joined-id');
    assert.strictEqual(localStorage.getItem(SESSION_ID_STORAGE_KEY), null);
  });
});
