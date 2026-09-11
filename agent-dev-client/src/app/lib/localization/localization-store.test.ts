import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { LocalizationClientBuild } from '../../../../../shared/localization.ts';
import { LocalizationStore, directionForLocale } from './localization-store.ts';

const REVISION = 'a'.repeat(64);
const BUILD: LocalizationClientBuild = {
  catalogRevision: REVISION,
  sourceLocale: 'en',
  bundles: [{ locale: 'en', messages: { count: '{count} bookings', home: 'Home' } }],
};

describe('LocalizationStore', () => {
  it('starts with the embedded source bundle and no claimed activation', () => {
    const store = new LocalizationStore(BUILD);
    assert.deepStrictEqual(store.getSnapshot(), {
      catalogRevision: REVISION,
      messageLocale: 'en',
      formatLocale: 'en',
      messages: { count: '{count} bookings', home: 'Home' },
      direction: 'ltr',
      activeIdentity: null,
      activationVersion: 0,
      transition: { status: 'idle' },
    });
  });

  it('covers first paint until a different navigator locale replaces the source default', () => {
    const store = new LocalizationStore(BUILD);
    assert.strictEqual(store.prepareInitialResolution('ja-JP', 'navigator'), 'ja-JP');
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'ja-JP',
      formatLocale: 'ja-JP',
    });

    assert.strictEqual(store.receiveCommitted(committed('en', 'en', 0, 'default')), true);
    assert.strictEqual(store.receiveBundleReady(ready('en', 0, BUILD.bundles[0].messages)), false);
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'ja-JP',
      formatLocale: 'ja-JP',
    });

    assert.strictEqual(store.receiveCommitted(committed('ja-JP', 'ja-JP', 1, 'navigator')), true);
    assert.strictEqual(
      store.receiveBundleReady(ready('ja-JP', 1, { count: '{count}件の予約', home: 'ホーム' })),
      true,
    );
    assert.strictEqual(store.getSnapshot().messageLocale, 'ja-JP');
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
  });

  it('releases a provisional navigator cover when the request fails', () => {
    const store = new LocalizationStore(BUILD);
    store.prepareInitialResolution('ka-GE', 'navigator');
    store.cancelInitialResolution('ka-GE', 'navigator');
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
    assert.strictEqual(store.getSnapshot().messageLocale, 'en');
  });

  it('does not claim to prepare UI when the navigator already uses the source language', () => {
    const store = new LocalizationStore(BUILD);
    assert.strictEqual(store.prepareInitialResolution('en-US', 'navigator'), 'en-US');
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
  });

  it('covers first paint until a saved explicit preference replaces interim session language', () => {
    const store = new LocalizationStore(BUILD);
    assert.strictEqual(store.prepareInitialResolution('en', 'explicit'), 'en');
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'en',
      formatLocale: 'en',
    });

    assert.strictEqual(store.receiveCommitted(committed('pl', 'pl', 3, 'explicit')), true);
    assert.strictEqual(store.persistableExplicitLocale(), null);
    assert.strictEqual(
      store.receiveBundleReady(ready('pl', 3, { count: '{count} rezerwacji', home: 'Główna' })),
      true,
    );
    assert.strictEqual(store.getSnapshot().messageLocale, 'pl');
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'en',
      formatLocale: 'en',
    });

    assert.strictEqual(store.receiveCommitted(committed('en', 'en', 4, 'explicit')), true);
    assert.strictEqual(store.persistableExplicitLocale(), 'en');
    assert.strictEqual(store.receiveBundleReady(ready('en', 4, BUILD.bundles[0].messages)), true);
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
  });

  it('waits for explicit authority when a saved preference matches the source locale', () => {
    const store = new LocalizationStore(BUILD);
    store.prepareInitialResolution('en', 'explicit');

    assert.strictEqual(store.receiveCommitted(committed('en', 'en', 0, 'default')), true);
    assert.strictEqual(store.persistableExplicitLocale(), null);
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'en',
      formatLocale: 'en',
    });

    assert.strictEqual(store.receiveCommitted(committed('en', 'en', 1, 'explicit')), true);
    assert.strictEqual(store.persistableExplicitLocale(), 'en');
  });

  it('lets an existing committed session locale outrank a provisional navigator hint', () => {
    const store = new LocalizationStore(BUILD);
    store.prepareInitialResolution('ja-JP', 'navigator');

    assert.strictEqual(store.receiveCommitted(committed('fr', 'fr', 2, 'explicit')), true);
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'fr',
      formatLocale: 'fr',
    });
  });

  it('reveals the valid session bundle if restoring a saved preference fails', () => {
    const store = new LocalizationStore(BUILD);
    store.prepareInitialResolution('en', 'explicit');
    store.receiveCommitted(committed('pl', 'pl', 3, 'conversation'));
    store.receiveBundleReady(ready('pl', 3, { count: '{count} rezerwacji', home: 'Główna' }));

    store.cancelInitialResolution('en', 'explicit');

    assert.strictEqual(store.getSnapshot().messageLocale, 'pl');
    assert.deepStrictEqual(store.getSnapshot().transition, { status: 'idle' });
  });

  it('restores the explicit cover on reconnect after an earlier restore request failed', () => {
    const store = new LocalizationStore(BUILD);
    store.prepareInitialResolution('en', 'explicit');
    store.receiveCommitted(committed('pl', 'pl', 3, 'conversation'));
    store.receiveBundleReady(ready('pl', 3, { count: '{count} rezerwacji', home: 'Główna' }));
    store.cancelInitialResolution('en', 'explicit');

    store.prepareInitialResolution('en', 'explicit');

    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'en',
      formatLocale: 'en',
    });
  });

  it('keeps prior UI on commit and atomically exposes only a complete current bundle', () => {
    const store = new LocalizationStore(BUILD);
    assert.strictEqual(store.receiveCommitted(committed('ar-EG', 'ar', 3)), true);
    assert.strictEqual(store.getSnapshot().messageLocale, 'en');
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'ar',
      formatLocale: 'ar-EG',
    });
    assert.strictEqual(
      store.receiveBundleReady(ready('ar', 3, { count: '{count} حجوزات', home: 'الرئيسية' })),
      true,
    );
    assert.deepStrictEqual(store.getSnapshot(), {
      catalogRevision: REVISION,
      messageLocale: 'ar',
      formatLocale: 'ar-EG',
      messages: { count: '{count} حجوزات', home: 'الرئيسية' },
      direction: 'rtl',
      activeIdentity: {
        catalogRevision: REVISION,
        messageLocale: 'ar',
        sessionLocaleRevision: 3,
      },
      activationVersion: 1,
      transition: { status: 'idle' },
    });
  });

  it('rejects stale, wrong-build, mismatched, incomplete, and noncanonical bundles', () => {
    const store = new LocalizationStore(BUILD);
    store.receiveCommitted(committed('fr-CA', 'fr', 4));
    assert.strictEqual(store.receiveCommitted(committed('de', 'de', 4)), false);
    assert.strictEqual(
      store.receiveBundleReady(ready('fr', 3, { count: '{count} réservations', home: 'Accueil' })),
      false,
    );
    assert.strictEqual(
      store.receiveBundleReady({
        ...ready('fr', 4, { count: '{count} réservations', home: 'Accueil' }),
        catalogRevision: 'b'.repeat(64),
      }),
      false,
    );
    assert.strictEqual(store.receiveBundleReady(ready('de', 4, { count: 'x', home: 'y' })), false);
    assert.strictEqual(store.receiveBundleReady(ready('fr', 4, { home: 'Accueil' })), false);
    assert.strictEqual(
      store.receiveBundleReady(ready('fr-ca', 4, { count: 'x', home: 'y' })),
      false,
    );
    assert.strictEqual(store.getSnapshot().messageLocale, 'en');
  });

  it('retries the committed locale and restores the failed state when transport rejects', async () => {
    const store = new LocalizationStore(BUILD);
    const requests: Array<{ locale: string; activeBundle: unknown }> = [];
    store.setResolutionRequester(async (locale, activeBundle) => {
      requests.push({ locale, activeBundle });
    });
    store.receiveCommitted(committed('mr-IN', 'mr', 2));
    store.receiveSourceFallback({
      catalogRevision: REVISION,
      messageLocale: 'mr',
      sessionLocaleRevision: 2,
      reason: 'generation-failed',
    });

    await store.retryResolution();

    assert.deepStrictEqual(requests, [{ locale: 'mr-IN', activeBundle: undefined }]);
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'pending',
      messageLocale: 'mr',
      formatLocale: 'mr-IN',
    });

    store.receiveSourceFallback({
      catalogRevision: REVISION,
      messageLocale: 'mr',
      sessionLocaleRevision: 2,
      reason: 'storage-failed',
    });
    store.setResolutionRequester(async () => {
      throw new Error('transport unavailable');
    });
    await store.retryResolution();
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'failed',
      messageLocale: 'mr',
      formatLocale: 'mr-IN',
      reason: 'storage-failed',
    });
  });

  it('requests a fresh acknowledgement for duplicate ready delivery', async () => {
    const store = new LocalizationStore(BUILD);
    store.receiveCommitted(committed('fr', 'fr', 1));
    const acknowledgements: unknown[] = [];
    store.setActivationSender(async (identity) => {
      acknowledgements.push(identity);
      return { accepted: true };
    });
    const bundle = ready('fr', 1, { count: '{count} réservations', home: 'Accueil' });
    store.receiveBundleReady(bundle);
    await store.acknowledgeInstalledActivation(
      store.getSnapshot().activationVersion,
      store.getSnapshot().activeIdentity,
    );
    store.receiveBundleReady(bundle);
    await store.acknowledgeInstalledActivation(
      store.getSnapshot().activationVersion,
      store.getSnapshot().activeIdentity,
    );
    assert.strictEqual(acknowledgements.length, 2);
    assert.strictEqual(store.getSnapshot().activationVersion, 2);
  });

  it('does not change active UI for a matching source fallback', () => {
    const store = new LocalizationStore(BUILD);
    store.receiveCommitted(committed('de', 'de', 2));
    assert.strictEqual(
      store.receiveSourceFallback({
        catalogRevision: REVISION,
        messageLocale: 'de',
        sessionLocaleRevision: 2,
        reason: 'generation-failed',
      }),
      true,
    );
    assert.strictEqual(store.getSnapshot().messageLocale, 'en');
    assert.deepStrictEqual(store.getSnapshot().transition, {
      status: 'failed',
      messageLocale: 'de',
      formatLocale: 'de',
      reason: 'generation-failed',
    });
  });

  it('derives direction from the locale script', () => {
    assert.strictEqual(directionForLocale('he-IL'), 'rtl');
    assert.strictEqual(directionForLocale('fa'), 'rtl');
    assert.strictEqual(directionForLocale('ja-JP'), 'ltr');
  });

  it('activates CJK and expanded wording without truncating bundle values', () => {
    const store = new LocalizationStore(BUILD);
    store.receiveCommitted(committed('ja-JP', 'ja', 5));
    assert.strictEqual(
      store.receiveBundleReady(
        ready('ja', 5, {
          count: '{count}件の予約',
          home: 'ホームページに戻るための非常に長いナビゲーションラベル',
        }),
      ),
      true,
    );
    assert.deepStrictEqual(store.getSnapshot().messages, {
      count: '{count}件の予約',
      home: 'ホームページに戻るための非常に長いナビゲーションラベル',
    });
    assert.strictEqual(store.getSnapshot().direction, 'ltr');
  });
});

function committed(
  formatLocale: string,
  messageLocale: string,
  revision: number,
  source: 'default' | 'navigator' | 'conversation' | 'explicit' = 'explicit',
) {
  return {
    catalogRevision: REVISION,
    locale: {
      messageLocale,
      formatLocale,
      source,
      revision,
    },
  };
}

function ready(locale: string, revision: number, messages: Record<string, string>) {
  return {
    catalogRevision: REVISION,
    messageLocale: locale,
    sessionLocaleRevision: revision,
    bundle: { locale, messages },
  };
}
