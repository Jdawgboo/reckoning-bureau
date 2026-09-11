import type {
  LocaleCommittedParams,
  LocaleHintParams,
  LocaleSourceFallbackParams,
  LocalizationBundle,
  LocalizationBundleIdentity,
  LocalizationFallbackReason,
  LocalizationResolveRequest,
  LocalizationResolveResult,
  LocalizationServerBuild,
  SessionPresentationLocale,
} from '../../../shared/index.ts';
import {
  LOCALE_BUNDLE_READY_METHOD,
  LOCALE_COMMITTED_METHOD,
  LOCALE_SOURCE_FALLBACK_METHOD,
} from '../../../shared/ws-protocol.ts';
import type { LocalizationResolver } from '../services/platform-localization-client.ts';
import {
  LocalizationFormatter,
  type LocalizationFormatValues,
} from '../services/localization-formatter.ts';

type LocaleProposalSource = 'navigator' | 'conversation' | 'explicit';

interface LocalizationSession {
  readonly sessionKey: string;
  readonly presentationLocale: SessionPresentationLocale;
  readonly localizationAttachmentIds: string[];
  proposeLocale(locale: string, source: LocaleProposalSource): Promise<SessionPresentationLocale>;
  broadcast(message: { method: string; params: unknown }): void;
  notifyClient(connectionId: string, message: { method: string; params: unknown }): boolean;
  recordLocalizationDelivery(connectionId: string, identity: LocalizationBundleIdentity): boolean;
  acknowledgeLocalization(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): { accepted: false } | { accepted: true; activationLagMs: number };
  restoreLocalizationActivation(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): boolean;
  recordLocalizationFallback(
    connectionId: string,
    identity: LocalizationBundleIdentity,
    reason: LocalizationFallbackReason,
  ): boolean;
}

export type LocalizationDeliveryResult =
  | { status: 'delivered'; delivered: number; identity: LocalizationBundleIdentity }
  | { status: 'fallback'; reason: LocalizationFallbackReason }
  | { status: 'stale' }
  | { status: 'detached' };

interface ResolvedBundle {
  status: 'ready';
  bundle: LocalizationBundle;
}

interface ResolvedFallback {
  status: 'source-fallback';
  reason: LocalizationFallbackReason;
  retryAfterMs?: number;
}

type BundleResolution = ResolvedBundle | ResolvedFallback;

const MAX_RETRY_DELAY_MS = 1_500;

export class SessionLocalizationService {
  readonly #build: LocalizationServerBuild;
  readonly #resolver: LocalizationResolver;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #inflight = new Map<string, Promise<LocalizationResolveResult>>();
  readonly #bundles = new Map<string, LocalizationBundle>();
  readonly #expectedMessageIds: string[];
  readonly #formatter = new LocalizationFormatter();

  constructor(params: {
    build: LocalizationServerBuild;
    resolver: LocalizationResolver;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  }) {
    this.#build = params.build;
    this.#resolver = params.resolver;
    this.#sleep =
      params.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = params.random ?? Math.random;
    const source = this.#build.bundles.find((bundle) => bundle.locale === this.#build.sourceLocale);
    if (!source) {
      throw new Error('Localization build is missing its complete source bundle.');
    }
    this.#expectedMessageIds = Object.keys(source.messages).sort();
    for (const bundle of this.#build.bundles) {
      this.#assertCompleteBundle(bundle);
      this.#bundles.set(bundle.locale, bundle);
    }
  }

  get catalogRevision(): string {
    return this.#build.catalogRevision;
  }

  selectMessageLocale(formatLocale: string): string {
    const normalized = normalizeLocale(formatLocale);
    return selectCompatibleBundle(this.#build.bundles, normalized)?.locale ?? normalized;
  }

  format(
    locale: SessionPresentationLocale,
    messageId: string,
    values?: LocalizationFormatValues,
  ): string {
    const bundle =
      this.#bundles.get(locale.messageLocale) ?? this.#bundles.get(this.#build.sourceLocale);
    if (!bundle) {
      throw new Error('Localization build is missing its source bundle.');
    }
    return this.#formatter.format(bundle, locale.formatLocale, messageId, values);
  }

  announce(session: LocalizationSession, connectionId?: string): void {
    const params: LocaleCommittedParams = {
      locale: session.presentationLocale,
      catalogRevision: this.#build.catalogRevision,
    };
    if (connectionId) {
      session.notifyClient(connectionId, { method: LOCALE_COMMITTED_METHOD, params });
      return;
    }
    session.broadcast({ method: LOCALE_COMMITTED_METHOD, params });
  }

  async attach(
    session: LocalizationSession,
    connectionId: string,
    hint?: LocaleHintParams,
  ): Promise<LocalizationDeliveryResult> {
    this.announce(session, connectionId);
    if (hint?.activeBundle) {
      this.#restoreActiveHint(session, connectionId, hint.activeBundle);
    }
    return this.deliver(session, [connectionId], true);
  }

  async hint(
    session: LocalizationSession,
    connectionId: string,
    hint: LocaleHintParams,
  ): Promise<SessionPresentationLocale> {
    if (hint.activeBundle) {
      this.#restoreActiveHint(session, connectionId, hint.activeBundle);
    }
    const before = session.presentationLocale;
    const committed = await session.proposeLocale(hint.locale, 'navigator');
    if (committed.revision !== before.revision) {
      this.#log('committed', session, identityFor(this.#build.catalogRevision, committed));
      this.announce(session);
      void this.deliver(session, session.localizationAttachmentIds, false);
    } else {
      this.announce(session, connectionId);
      void this.deliver(session, [connectionId], true);
    }
    return committed;
  }

  async propose(
    session: LocalizationSession,
    locale: string,
    source: LocaleProposalSource,
  ): Promise<SessionPresentationLocale> {
    const before = session.presentationLocale;
    const committed = await session.proposeLocale(locale, source);
    const changed = committed.revision !== before.revision;
    if (changed) {
      this.#log('committed', session, identityFor(this.#build.catalogRevision, committed));
      this.announce(session);
      void this.deliver(session, session.localizationAttachmentIds, source === 'explicit');
    } else if (source === 'explicit') {
      this.announce(session);
      void this.deliver(session, session.localizationAttachmentIds, true);
    }
    return committed;
  }

  acknowledge(
    session: LocalizationSession,
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): boolean {
    if (identity.catalogRevision !== this.#build.catalogRevision) {
      return false;
    }
    const acknowledgement = session.acknowledgeLocalization(connectionId, identity);
    if (acknowledgement.accepted) {
      this.#log('acknowledged', session, identity, {
        activationLagMs: acknowledgement.activationLagMs,
      });
    }
    return acknowledgement.accepted;
  }

  async deliver(
    session: LocalizationSession,
    connectionIds: readonly string[],
    allowRetry: boolean,
  ): Promise<LocalizationDeliveryResult> {
    const committed = session.presentationLocale;
    const resolution = await this.#resolve(committed.messageLocale, allowRetry);
    if (!isCurrent(session.presentationLocale, committed)) {
      this.#log('stale', session, identityFor(this.#build.catalogRevision, committed));
      return { status: 'stale' };
    }
    const identity = identityFor(this.#build.catalogRevision, committed);
    if (resolution.status === 'source-fallback') {
      const params: LocaleSourceFallbackParams = {
        ...identity,
        reason: resolution.reason,
        ...(resolution.retryAfterMs === undefined ? {} : { retryAfterMs: resolution.retryAfterMs }),
      };
      for (const connectionId of connectionIds) {
        if (session.recordLocalizationFallback(connectionId, identity, resolution.reason)) {
          session.notifyClient(connectionId, { method: LOCALE_SOURCE_FALLBACK_METHOD, params });
        }
      }
      this.#log('fallback', session, identity, { reason: resolution.reason });
      return { status: 'fallback', reason: resolution.reason };
    }

    this.#assertCompleteBundle(resolution.bundle);
    this.#bundles.set(resolution.bundle.locale, resolution.bundle);
    if (connectionIds.length === 0) {
      return { status: 'detached' };
    }
    let delivered = 0;
    for (const connectionId of connectionIds) {
      if (!session.recordLocalizationDelivery(connectionId, identity)) {
        continue;
      }
      if (
        session.notifyClient(connectionId, {
          method: LOCALE_BUNDLE_READY_METHOD,
          params: { ...identity, bundle: resolution.bundle },
        })
      ) {
        delivered += 1;
      }
    }
    if (delivered > 0) {
      this.#log('delivered', session, identity, { attachmentCount: delivered });
      return { status: 'delivered', delivered, identity };
    }
    return { status: 'detached' };
  }

  async #resolve(messageLocale: string, allowRetry: boolean): Promise<BundleResolution> {
    const built = this.#bundles.get(messageLocale);
    if (built) {
      return { status: 'ready', bundle: built };
    }
    const request: LocalizationResolveRequest = {
      catalogRevision: this.#build.catalogRevision,
      messageLocale,
      policyVersion: this.#build.policyVersion,
      catalogJson: this.#build.catalogJson,
    };
    const attempts = allowRetry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let result: LocalizationResolveResult;
      try {
        result = await this.#resolveOnce(request);
      } catch (error) {
        logResolverFailure(request, error);
        result = {
          status: 'source-fallback',
          catalogRevision: request.catalogRevision,
          messageLocale: request.messageLocale,
          policyVersion: request.policyVersion,
          reason: 'storage-failed',
        };
      }
      if (result.status === 'ready') {
        try {
          this.#assertCompleteBundle(result.bundle);
          this.#bundles.set(result.bundle.locale, result.bundle);
          return { status: 'ready', bundle: result.bundle };
        } catch {
          return { status: 'source-fallback', reason: 'generation-failed' };
        }
      }
      if (attempt + 1 >= attempts || !isRetryable(result.reason)) {
        return {
          status: 'source-fallback',
          reason: result.reason,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        };
      }
      await this.#sleep(this.#retryDelay(result.retryAfterMs));
    }
    return { status: 'source-fallback', reason: 'generation-failed' };
  }

  #resolveOnce(request: LocalizationResolveRequest): Promise<LocalizationResolveResult> {
    const key = `${request.catalogRevision}:${request.messageLocale}:${request.policyVersion}`;
    const existing = this.#inflight.get(key);
    if (existing) {
      return existing;
    }
    const operation = this.#resolver.resolve(request);
    this.#inflight.set(key, operation);
    void operation.then(
      () => this.#clearInflight(key, operation),
      () => this.#clearInflight(key, operation),
    );
    return operation;
  }

  #clearInflight(key: string, operation: Promise<LocalizationResolveResult>): void {
    if (this.#inflight.get(key) === operation) {
      this.#inflight.delete(key);
    }
  }

  #assertCompleteBundle(bundle: LocalizationBundle): void {
    const locale = normalizeLocale(bundle.locale);
    if (locale !== bundle.locale) {
      throw new Error('Localization bundle locale is not canonical.');
    }
    const actualIds = Object.keys(bundle.messages).sort();
    if (
      actualIds.length !== this.#expectedMessageIds.length ||
      actualIds.some((id, index) => id !== this.#expectedMessageIds[index])
    ) {
      throw new Error('Localization bundle is incomplete.');
    }
    const locks = this.#build.ownerOverlays.find((overlay) => overlay.locale === bundle.locale);
    if (!locks) {
      return;
    }
    for (const [id, value] of Object.entries(locks.messages)) {
      if (bundle.messages[id] !== value) {
        throw new Error('Localization bundle changed owner-provided wording.');
      }
    }
  }

  #restoreActiveHint(
    session: LocalizationSession,
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): void {
    const current = session.presentationLocale;
    if (
      identity.catalogRevision !== this.#build.catalogRevision ||
      identity.sessionLocaleRevision > current.revision
    ) {
      return;
    }
    try {
      if (normalizeLocale(identity.messageLocale) !== identity.messageLocale) {
        return;
      }
    } catch {
      return;
    }
    session.restoreLocalizationActivation(connectionId, identity);
  }

  #retryDelay(retryAfterMs: number | undefined): number {
    const ceiling = Math.min(retryAfterMs ?? 500, MAX_RETRY_DELAY_MS);
    return Math.max(1, Math.round(ceiling * (0.75 + this.#random() * 0.5)));
  }

  #log(
    event: 'committed' | 'delivered' | 'acknowledged' | 'fallback' | 'stale',
    session: LocalizationSession,
    identity: LocalizationBundleIdentity,
    extra: {
      reason?: LocalizationFallbackReason;
      attachmentCount?: number;
      activationLagMs?: number;
    } = {},
  ): void {
    console.log(
      JSON.stringify({
        level: 'info',
        event: `localization.${event}`,
        sessionKey: session.sessionKey,
        catalogRevision: identity.catalogRevision,
        messageLocale: identity.messageLocale,
        sessionLocaleRevision: identity.sessionLocaleRevision,
        ...(extra.reason ? { reason: extra.reason } : {}),
        ...(extra.attachmentCount === undefined ? {} : { attachmentCount: extra.attachmentCount }),
        ...(extra.activationLagMs === undefined ? {} : { activationLagMs: extra.activationLagMs }),
      }),
    );
  }
}

export function selectCompatibleBundle(
  bundles: readonly LocalizationBundle[],
  requestedLocale: string,
): LocalizationBundle | null {
  const requested = localeParts(requestedLocale);
  const exact = bundles.find((bundle) => bundle.locale === requested.locale);
  if (exact) {
    return exact;
  }
  const sameLanguageScript = bundles.find((bundle) => {
    const candidate = localeParts(bundle.locale);
    return candidate.language === requested.language && candidate.script === requested.script;
  });
  if (sameLanguageScript) {
    return sameLanguageScript;
  }
  return (
    bundles.find((bundle) => {
      const candidate = localeParts(bundle.locale);
      return candidate.language === requested.language && candidate.locale === candidate.language;
    }) ?? null
  );
}

function localeParts(locale: string): { locale: string; language: string; script: string } {
  const normalized = normalizeLocale(locale);
  const parsed = new Intl.Locale(normalized);
  return {
    locale: normalized,
    language: parsed.language,
    script: parsed.maximize().script ?? '',
  };
}

function normalizeLocale(locale: string): string {
  const canonical = Intl.getCanonicalLocales(locale.trim());
  if (canonical.length !== 1) {
    throw new Error('Expected one localization locale.');
  }
  return canonical[0];
}

function identityFor(
  catalogRevision: string,
  locale: SessionPresentationLocale,
): LocalizationBundleIdentity {
  return {
    catalogRevision,
    messageLocale: locale.messageLocale,
    sessionLocaleRevision: locale.revision,
  };
}

function isCurrent(
  current: SessionPresentationLocale,
  captured: SessionPresentationLocale,
): boolean {
  return current.revision === captured.revision && current.messageLocale === captured.messageLocale;
}

function isRetryable(reason: LocalizationFallbackReason): boolean {
  return reason === 'busy' || reason === 'generation-failed' || reason === 'storage-failed';
}

function logResolverFailure(request: LocalizationResolveRequest, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'localization.resolve-failed',
      catalogRevision: request.catalogRevision,
      messageLocale: request.messageLocale,
      policyVersion: request.policyVersion,
      error: error instanceof Error ? error.message : 'Unknown localization resolver failure.',
    }),
  );
}
