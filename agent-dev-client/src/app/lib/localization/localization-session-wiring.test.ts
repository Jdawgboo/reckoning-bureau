import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { LocalizationBundleIdentity } from '../../../../../shared/localization.ts';
import {
  LOCALE_BUNDLE_READY_METHOD,
  LOCALE_COMMITTED_METHOD,
  LOCALE_SOURCE_FALLBACK_METHOD,
  type LocaleCommittedParams,
  type LocaleSourceFallbackParams,
} from '../../../../../shared/ws-protocol.ts';
import {
  type LocalePreferenceStorage,
  loadExplicitLocalePreference,
  saveExplicitLocalePreference,
} from './explicit-locale-preference.ts';
import { LocalizationStore } from './localization-store.ts';
import { wireLocalizationSession } from './localization-session-wiring.ts';

const REVISION = 'a'.repeat(64);
const BUILD = {
  catalogRevision: REVISION,
  sourceLocale: 'en',
  bundles: [{ locale: 'en', messages: { home: 'Home' } }],
};

type LocalizationNotificationMethod =
  | typeof LOCALE_COMMITTED_METHOD
  | typeof LOCALE_BUNDLE_READY_METHOD
  | typeof LOCALE_SOURCE_FALLBACK_METHOD;

class MemoryStorage implements LocalePreferenceStorage {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  unavailable = false;

  getItem(key: string): string | null {
    if (this.unavailable) {
      throw new Error('storage unavailable');
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.unavailable) {
      throw new Error('storage unavailable');
    }
    this.values.set(key, value);
    this.writes.push(value);
  }

  removeItem(key: string): void {
    if (this.unavailable) {
      throw new Error('storage unavailable');
    }
    this.values.delete(key);
  }
}

class LocalizationTransport {
  readonly hints: Array<{ locale: string; activeBundle?: LocalizationBundleIdentity }> = [];
  readonly proposals: string[] = [];
  readonly activations: LocalizationBundleIdentity[] = [];
  rejectProposal = false;
  #joined: (() => void) | null = null;
  #localized: ((method: LocalizationNotificationMethod, params: unknown) => void) | null = null;

  onLocalization(handler: (method: LocalizationNotificationMethod, params: unknown) => void): void {
    this.#localized = handler;
  }

  onSessionJoined(handler: () => void): void {
    this.#joined = handler;
  }

  async localeHint(locale: string, activeBundle?: LocalizationBundleIdentity): Promise<unknown> {
    this.hints.push({ locale, activeBundle });
    return undefined;
  }

  async proposeLocale(locale: string): Promise<unknown> {
    this.proposals.push(locale);
    if (this.rejectProposal) {
      throw new Error('transport unavailable');
    }
    return undefined;
  }

  async activateLocale(identity: LocalizationBundleIdentity): Promise<{ accepted: boolean }> {
    this.activations.push(identity);
    return { accepted: true };
  }

  join(): void {
    assert.ok(this.#joined);
    this.#joined();
  }

  committed(params: LocaleCommittedParams): void {
    assert.ok(this.#localized);
    this.#localized(LOCALE_COMMITTED_METHOD, params);
  }

  bundleReady(params: unknown): void {
    assert.ok(this.#localized);
    this.#localized(LOCALE_BUNDLE_READY_METHOD, params);
  }

  sourceFallback(params: LocaleSourceFallbackParams): void {
    assert.ok(this.#localized);
    this.#localized(LOCALE_SOURCE_FALLBACK_METHOD, params);
  }
}

describe('localization session wiring', () => {
  it('re-reads storage on join so a stale tab cannot overwrite a newer choice', () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('pl', storage);
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    wireLocalizationSession(store, transport, storage);

    saveExplicitLocalePreference('en', storage);
    transport.join();

    assert.deepStrictEqual(transport.proposals, ['en']);
    assert.deepStrictEqual(transport.hints, []);
  });

  it('does not persist an interim session locale while restoring an explicit choice', () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('en', storage);
    storage.writes.length = 0;
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    wireLocalizationSession(store, transport, storage);
    transport.join();

    transport.committed(committed('pl', 3));
    assert.deepStrictEqual(storage.writes, []);
    assert.strictEqual(loadExplicitLocalePreference(storage), 'en');

    transport.committed(committed('en', 4));
    assert.deepStrictEqual(storage.writes, ['en']);
  });

  it('falls back to navigator intent only when no explicit preference exists', () => {
    const storage = new MemoryStorage();
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    wireLocalizationSession(store, transport, storage);

    transport.join();

    assert.deepStrictEqual(transport.proposals, []);
    assert.strictEqual(transport.hints.length, 1);
    assert.strictEqual(transport.hints[0].locale, store.navigatorLocale());
  });

  it('reveals the existing presentation when explicit restoration cannot be requested', async () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('fr', storage);
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    transport.rejectProposal = true;
    wireLocalizationSession(store, transport, storage);

    transport.join();
    assert.strictEqual(store.getSnapshot().transition.status, 'pending');
    await Promise.resolve();
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
  });

  it('routes ready bundles and activation acknowledgements through the transport', async () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('fr', storage);
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    wireLocalizationSession(store, transport, storage);
    transport.join();
    transport.committed(committed('fr', 1));
    transport.bundleReady({
      catalogRevision: REVISION,
      messageLocale: 'fr',
      sessionLocaleRevision: 1,
      bundle: { locale: 'fr', messages: { home: 'Accueil' } },
    });

    await store.acknowledgeInstalledActivation(
      store.getSnapshot().activationVersion,
      store.getSnapshot().activeIdentity,
    );

    assert.deepStrictEqual(transport.activations, [
      { catalogRevision: REVISION, messageLocale: 'fr', sessionLocaleRevision: 1 },
    ]);
  });

  it('routes a correlated source fallback into the presentation state', () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('fr', storage);
    const store = new LocalizationStore(BUILD);
    const transport = new LocalizationTransport();
    wireLocalizationSession(store, transport, storage);
    transport.join();
    transport.committed(committed('fr', 1));

    transport.sourceFallback({
      catalogRevision: REVISION,
      messageLocale: 'fr',
      sessionLocaleRevision: 1,
      reason: 'generation-failed',
    });

    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'failed',
      messageLocale: 'fr',
      formatLocale: 'fr',
      reason: 'generation-failed',
    });
  });
});

function committed(formatLocale: string, revision: number): LocaleCommittedParams {
  return {
    catalogRevision: REVISION,
    locale: {
      messageLocale: formatLocale,
      formatLocale,
      source: 'explicit',
      revision,
    },
  };
}
