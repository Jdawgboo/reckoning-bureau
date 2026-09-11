import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import type {
  LocalizationBundleIdentity,
  LocalizationResolveRequest,
  LocalizationResolveResult,
  LocalizationServerBuild,
  SessionPresentationLocale,
} from '../../../shared/index.ts';
import type { LocalizationResolver } from '../services/platform-localization-client.ts';
import {
  SessionLocalizationService,
  selectCompatibleBundle,
} from './session-localization.service.ts';

const CATALOG_REVISION = 'a'.repeat(64);

const BUILD: LocalizationServerBuild = {
  catalogRevision: CATALOG_REVISION,
  sourceLocale: 'en',
  policyVersion: 'localization-v4',
  catalogJson: '{"catalogVersion":1}',
  bundles: [
    { locale: 'en', messages: { count: '{count} bookings', home: 'Home' } },
    { locale: 'fr', messages: { count: '{count} réservations', home: 'Accueil' } },
  ],
  ownerOverlays: [
    { locale: 'fr', messages: { count: '{count} réservations', home: 'Accueil' } },
    { locale: 'de', messages: { home: 'Startseite' } },
  ],
};

class Resolver implements LocalizationResolver {
  readonly requests: LocalizationResolveRequest[] = [];
  response: (request: LocalizationResolveRequest) => Promise<LocalizationResolveResult>;

  constructor(
    response: (request: LocalizationResolveRequest) => Promise<LocalizationResolveResult>,
  ) {
    this.response = response;
  }

  resolve(request: LocalizationResolveRequest): Promise<LocalizationResolveResult> {
    this.requests.push(structuredClone(request));
    return this.response(request);
  }
}

class Session {
  readonly sessionKey = 'session-1';
  presentationLocale: SessionPresentationLocale;
  localizationAttachmentIds = ['browser-1'];
  readonly notifications = new Map<string, Array<{ method: string; params: unknown }>>();
  readonly broadcasts: Array<{ method: string; params: unknown }> = [];
  readonly delivered = new Map<string, LocalizationBundleIdentity>();
  readonly acknowledged = new Map<string, LocalizationBundleIdentity>();

  constructor(locale: SessionPresentationLocale = presentation('de', 1)) {
    this.presentationLocale = locale;
  }

  async proposeLocale(
    locale: string,
    source: 'navigator' | 'conversation' | 'explicit',
  ): Promise<SessionPresentationLocale> {
    this.presentationLocale = {
      messageLocale: locale,
      formatLocale: locale,
      source,
      revision: this.presentationLocale.revision + 1,
    };
    return { ...this.presentationLocale };
  }

  broadcast(message: { method: string; params: unknown }): void {
    this.broadcasts.push(message);
  }

  notifyClient(connectionId: string, message: { method: string; params: unknown }): boolean {
    if (!this.localizationAttachmentIds.includes(connectionId)) {
      return false;
    }
    const messages = this.notifications.get(connectionId) ?? [];
    messages.push(message);
    this.notifications.set(connectionId, messages);
    return true;
  }

  recordLocalizationDelivery(connectionId: string, identity: LocalizationBundleIdentity): boolean {
    if (!this.localizationAttachmentIds.includes(connectionId)) {
      return false;
    }
    const prior = this.delivered.get(connectionId);
    if (prior && sameIdentity(prior, identity)) {
      return false;
    }
    this.delivered.set(connectionId, { ...identity });
    return true;
  }

  acknowledgeLocalization(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): { accepted: false } | { accepted: true; activationLagMs: number } {
    const delivered = this.delivered.get(connectionId);
    if (!delivered || !sameIdentity(delivered, identity)) {
      return { accepted: false };
    }
    this.acknowledged.set(connectionId, { ...identity });
    return { accepted: true, activationLagMs: 12 };
  }

  restoreLocalizationActivation(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): boolean {
    if (!this.localizationAttachmentIds.includes(connectionId)) {
      return false;
    }
    this.delivered.set(connectionId, { ...identity });
    this.acknowledged.set(connectionId, { ...identity });
    return true;
  }

  recordLocalizationFallback(
    connectionId: string,
    _identity: LocalizationBundleIdentity,
    _reason: 'busy' | 'rate-limited' | 'generation-failed' | 'storage-failed',
  ): boolean {
    return this.localizationAttachmentIds.includes(connectionId);
  }
}

describe('SessionLocalizationService', () => {
  it('selects exact, compatible language-script, base language, then an unprepared target', () => {
    const bundles = [
      BUILD.bundles[0],
      { locale: 'zh-Hant', messages: BUILD.bundles[0].messages },
      { locale: 'pt', messages: BUILD.bundles[0].messages },
    ];
    assert.strictEqual(selectCompatibleBundle(bundles, 'zh-Hant')?.locale, 'zh-Hant');
    assert.strictEqual(selectCompatibleBundle(bundles, 'zh-TW')?.locale, 'zh-Hant');
    assert.strictEqual(selectCompatibleBundle(bundles, 'pt-BR')?.locale, 'pt');
    assert.strictEqual(selectCompatibleBundle(bundles, 'de'), null);
  });

  it('delivers a complete owner bundle without an HTTP request', async () => {
    const resolver = readyResolver();
    const service = new SessionLocalizationService({ build: BUILD, resolver });
    const session = new Session(presentation('fr', 1));

    assert.deepStrictEqual(await service.deliver(session, ['browser-1'], false), {
      status: 'delivered',
      delivered: 1,
      identity: identity('fr', 1),
    });
    assert.strictEqual(resolver.requests.length, 0);
    assert.strictEqual(session.notifications.get('browser-1')?.[0]?.method, 'locale.bundleReady');
  });

  it('sends only the embedded catalog to JIT and preserves partial owner locks', async () => {
    const resolver = readyResolver({ count: '{count} Buchungen', home: 'Startseite' });
    const service = new SessionLocalizationService({ build: BUILD, resolver });
    const session = new Session();

    await service.deliver(session, ['browser-1'], false);
    assert.deepStrictEqual(resolver.requests, [
      {
        catalogRevision: CATALOG_REVISION,
        messageLocale: 'de',
        policyVersion: 'localization-v4',
        catalogJson: BUILD.catalogJson,
      },
    ]);
    assert.strictEqual(JSON.stringify(resolver.requests).includes('visitor'), false);
    assert.deepStrictEqual(session.notifications.get('browser-1')?.[0], {
      method: 'locale.bundleReady',
      params: {
        ...identity('de', 1),
        bundle: {
          locale: 'de',
          messages: { count: '{count} Buchungen', home: 'Startseite' },
        },
      },
    });
  });

  it('shares an in-flight resolve but delivers only to still-live attachments', async () => {
    const pending = deferred<LocalizationResolveResult>();
    const resolver = new Resolver(async () => pending.promise);
    const service = new SessionLocalizationService({ build: BUILD, resolver });
    const session = new Session();
    session.localizationAttachmentIds.push('browser-2');

    const first = service.deliver(session, ['browser-1'], false);
    const second = service.deliver(session, ['browser-2'], false);
    session.localizationAttachmentIds = ['browser-2'];
    pending.resolve(ready('de', { count: '{count} Buchungen', home: 'Startseite' }));

    assert.deepStrictEqual(await first, { status: 'detached' });
    assert.strictEqual((await second).status, 'delivered');
    assert.strictEqual(resolver.requests.length, 1);
    assert.strictEqual(session.notifications.has('browser-1'), false);
    assert.strictEqual(session.notifications.get('browser-2')?.length, 1);
  });

  it('warms the runtime formatter when JIT finishes without a browser attachment', async () => {
    const resolver = readyResolver({ count: '{count} Buchungen', home: 'Startseite' });
    const service = new SessionLocalizationService({ build: BUILD, resolver });
    const session = new Session();

    assert.deepStrictEqual(await service.deliver(session, [], false), { status: 'detached' });
    assert.strictEqual(resolver.requests.length, 1);
    assert.strictEqual(service.format(session.presentationLocale, 'home'), 'Startseite');
    assert.strictEqual(
      service.format(session.presentationLocale, 'count', { count: 12 }),
      '12 Buchungen',
    );

    assert.deepStrictEqual(await service.deliver(session, ['browser-1'], false), {
      status: 'delivered',
      delivered: 1,
      identity: identity('de', 1),
    });
    assert.strictEqual(resolver.requests.length, 1);
  });

  it('never sends a result after the committed session revision changes', async () => {
    const pending = deferred<LocalizationResolveResult>();
    const resolver = new Resolver(async () => pending.promise);
    const service = new SessionLocalizationService({ build: BUILD, resolver });
    const session = new Session();
    const delivery = service.deliver(session, ['browser-1'], false);
    session.presentationLocale = presentation('es', 2);
    pending.resolve(ready('de', { count: '{count} Buchungen', home: 'Startseite' }));

    assert.deepStrictEqual(await delivery, { status: 'stale' });
    assert.strictEqual(session.notifications.size, 0);
  });

  it('deduplicates delivery and accepts only the exact delivered acknowledgement', async () => {
    const service = new SessionLocalizationService({ build: BUILD, resolver: readyResolver() });
    const session = new Session(presentation('fr', 4));
    await service.deliver(session, ['browser-1'], false);
    assert.deepStrictEqual(await service.deliver(session, ['browser-1'], false), {
      status: 'detached',
    });
    assert.strictEqual(service.acknowledge(session, 'browser-1', identity('fr', 3)), false);
    assert.strictEqual(service.acknowledge(session, 'browser-1', identity('fr', 4)), true);
  });

  it('uses one capped retry only for reconnect or explicit-request delivery', async () => {
    let attempts = 0;
    const resolver = new Resolver(async (request) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 'source-fallback',
          catalogRevision: request.catalogRevision,
          messageLocale: request.messageLocale,
          policyVersion: request.policyVersion,
          reason: 'busy',
          retryAfterMs: 1_000,
        };
      }
      return ready('de', { count: '{count} Buchungen', home: 'Startseite' });
    });
    const delays: number[] = [];
    const service = new SessionLocalizationService({
      build: BUILD,
      resolver,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      random: () => 0.5,
    });

    assert.strictEqual(
      (await service.deliver(new Session(), ['browser-1'], true)).status,
      'delivered',
    );
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(delays, [1_000]);
  });

  it('keeps source/prior UI and logs the resolver cause on transport failure', async () => {
    const warnings: string[] = [];
    const restore = mock.method(console, 'warn', (line: string) => {
      warnings.push(String(line));
    });
    const failed = new Resolver(async () => {
      throw new Error('timeout');
    });
    try {
      const service = new SessionLocalizationService({ build: BUILD, resolver: failed });
      const session = new Session();
      assert.deepStrictEqual(await service.deliver(session, ['browser-1'], false), {
        status: 'fallback',
        reason: 'storage-failed',
      });
      assert.strictEqual(
        session.notifications.get('browser-1')?.[0]?.method,
        'locale.sourceFallback',
      );
      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(JSON.parse(warnings[0]), {
        level: 'warn',
        event: 'localization.resolve-failed',
        catalogRevision: BUILD.catalogRevision,
        messageLocale: 'de',
        policyVersion: BUILD.policyVersion,
        error: 'timeout',
      });
    } finally {
      restore.mock.restore();
    }
  });

  it('rejects a generated bundle that changes an owner lock', async () => {
    const invalid = readyResolver({ count: '{count} Buchungen', home: 'Neu geschrieben' });
    assert.deepStrictEqual(
      await new SessionLocalizationService({ build: BUILD, resolver: invalid }).deliver(
        new Session(),
        ['browser-1'],
        false,
      ),
      { status: 'fallback', reason: 'generation-failed' },
    );
  });

  it('rehydrated desired locale resolves again and normally receives the cache response', async () => {
    const resolver = readyResolver({ count: '{count} Buchungen', home: 'Startseite' });
    const restartedService = new SessionLocalizationService({ build: BUILD, resolver });
    const rehydratedSession = new Session({
      messageLocale: 'de',
      formatLocale: 'de-DE',
      source: 'explicit',
      revision: 8,
    });
    assert.strictEqual(
      (await restartedService.attach(rehydratedSession, 'browser-1')).status,
      'delivered',
    );
    assert.strictEqual(resolver.requests.length, 1);
    assert.strictEqual(
      rehydratedSession.notifications.get('browser-1')?.[0]?.method,
      'locale.committed',
    );
    assert.strictEqual(
      rehydratedSession.notifications.get('browser-1')?.[1]?.method,
      'locale.bundleReady',
    );
  });
});

function presentation(locale: string, revision: number): SessionPresentationLocale {
  return { messageLocale: locale, formatLocale: locale, source: 'explicit', revision };
}

function identity(locale: string, revision: number): LocalizationBundleIdentity {
  return {
    catalogRevision: CATALOG_REVISION,
    messageLocale: locale,
    sessionLocaleRevision: revision,
  };
}

function ready(locale: string, messages: Record<string, string>): LocalizationResolveResult {
  return {
    status: 'ready',
    catalogRevision: CATALOG_REVISION,
    policyVersion: 'localization-v4',
    bundle: { locale, messages },
  };
}

function readyResolver(
  messages: Record<string, string> = { count: '{count} Buchungen', home: 'Startseite' },
): Resolver {
  return new Resolver(async (request) => ready(request.messageLocale, messages));
}

function sameIdentity(
  left: LocalizationBundleIdentity,
  right: LocalizationBundleIdentity,
): boolean {
  return (
    left.catalogRevision === right.catalogRevision &&
    left.messageLocale === right.messageLocale &&
    left.sessionLocaleRevision === right.sessionLocaleRevision
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) {
        throw new Error('Deferred promise was not initialized.');
      }
      resolvePromise(value);
    },
  };
}
