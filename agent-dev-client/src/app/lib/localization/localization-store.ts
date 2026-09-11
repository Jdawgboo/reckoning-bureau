import type {
  LocaleBundleReadyParams,
  LocaleCommittedParams,
  LocaleSourceFallbackParams,
  LocalizationBundleIdentity,
  LocalizationClientBuild,
  SessionPresentationLocale,
} from '../../../../../shared/index.ts';
import { isRecord } from '../util/type-guards.ts';

export type TextDirection = 'ltr' | 'rtl';
export type InitialLocaleSource = 'navigator' | 'explicit';

export type LocalizationTransition =
  | { status: 'idle' }
  | {
      status: 'pending';
      messageLocale: string;
      formatLocale: string;
    }
  | {
      status: 'failed';
      messageLocale: string;
      formatLocale: string;
      reason: LocaleSourceFallbackParams['reason'];
    };

export interface LocalizationSnapshot {
  catalogRevision: string;
  messageLocale: string;
  formatLocale: string;
  messages: Readonly<Record<string, string>>;
  direction: TextDirection;
  activeIdentity: LocalizationBundleIdentity | null;
  activationVersion: number;
  transition: LocalizationTransition;
}

type ActivationSender = (identity: LocalizationBundleIdentity) => Promise<{ accepted: boolean }>;
type ResolutionRequester = (
  locale: string,
  activeBundle?: LocalizationBundleIdentity,
) => Promise<unknown>;

const RTL_SCRIPTS = new Set([
  'Adlm',
  'Arab',
  'Hebr',
  'Mand',
  'Mend',
  'Nkoo',
  'Rohg',
  'Samr',
  'Syrc',
  'Thaa',
]);

export class LocalizationStore {
  readonly #build: LocalizationClientBuild;
  readonly #sourceIds: string[];
  readonly #listeners = new Set<() => void>();
  #desired: SessionPresentationLocale | null = null;
  #snapshot: LocalizationSnapshot;
  #activationSender: ActivationSender | null = null;
  #resolutionRequester: ResolutionRequester | null = null;
  #provisionalInitialLocale: { locale: string; source: InitialLocaleSource } | null = null;
  #acknowledging: Promise<void> | null = null;
  #pendingAcknowledgement: {
    version: number;
    identity: LocalizationBundleIdentity;
  } | null = null;
  #lastAcknowledgedVersion = 0;

  constructor(build: LocalizationClientBuild) {
    this.#build = build;
    const sourceBundle = build.bundles.find((bundle) => bundle.locale === build.sourceLocale);
    if (!sourceBundle) {
      throw new Error('Localization client build is missing its source bundle.');
    }
    this.#sourceIds = Object.keys(sourceBundle.messages).sort();
    this.#assertCompleteMessages(sourceBundle.messages);
    this.#snapshot = {
      catalogRevision: build.catalogRevision,
      messageLocale: build.sourceLocale,
      formatLocale: build.sourceLocale,
      messages: { ...sourceBundle.messages },
      direction: directionForLocale(build.sourceLocale),
      activeIdentity: null,
      activationVersion: 0,
      transition: { status: 'idle' },
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): LocalizationSnapshot => this.#snapshot;

  get sourceLocale(): string {
    return this.#build.sourceLocale;
  }

  persistableExplicitLocale(): string | null {
    if (this.#provisionalInitialLocale?.source === 'explicit') {
      return null;
    }
    return this.#desired?.source === 'explicit' ? this.#desired.formatLocale : null;
  }

  setActivationSender(sender: ActivationSender): void {
    this.#activationSender = sender;
  }

  setResolutionRequester(requester: ResolutionRequester): void {
    this.#resolutionRequester = requester;
  }

  prepareInitialResolution(locale: string, source: InitialLocaleSource): string {
    const normalized = canonicalLocale(locale);
    if (source === 'explicit') {
      const desired = this.#desired;
      if (
        desired?.source === 'explicit' &&
        desired.formatLocale === normalized &&
        isActivePresentation(this.#snapshot.activeIdentity, desired)
      ) {
        return normalized;
      }
      this.#provisionalInitialLocale = { locale: normalized, source };
      this.#setTransition({
        status: 'pending',
        messageLocale: normalized,
        formatLocale: normalized,
      });
      return normalized;
    }
    if (
      this.#desired ||
      this.#snapshot.activeIdentity ||
      sameMessageLanguage(normalized, this.#snapshot.messageLocale)
    ) {
      return normalized;
    }
    this.#provisionalInitialLocale = { locale: normalized, source };
    this.#setTransition({
      status: 'pending',
      messageLocale: normalized,
      formatLocale: normalized,
    });
    return normalized;
  }

  cancelInitialResolution(locale: string, source: InitialLocaleSource): void {
    let normalized: string;
    try {
      normalized = canonicalLocale(locale);
    } catch {
      return;
    }
    if (
      this.#provisionalInitialLocale?.locale !== normalized ||
      this.#provisionalInitialLocale.source !== source
    ) {
      return;
    }
    this.#provisionalInitialLocale = null;
    const desired = this.#desired;
    if (!desired || isActivePresentation(this.#snapshot.activeIdentity, desired)) {
      this.#setTransition({ status: 'idle' });
      return;
    }
    this.#setTransition({
      status: 'pending',
      messageLocale: desired.messageLocale,
      formatLocale: desired.formatLocale,
    });
  }

  async retryResolution(): Promise<void> {
    const desired = this.#desired;
    const requester = this.#resolutionRequester;
    const failed = this.#snapshot.transition;
    if (!desired || !requester || failed.status !== 'failed') {
      return;
    }
    this.#setTransition({
      status: 'pending',
      messageLocale: desired.messageLocale,
      formatLocale: desired.formatLocale,
    });
    try {
      await requester(desired.formatLocale, this.activeIdentity());
    } catch {
      if (this.#desired && samePresentationLocale(this.#desired, desired)) {
        this.#setTransition(failed);
      }
    }
  }

  receiveCommitted(value: unknown): boolean {
    const committed = readCommitted(value);
    if (!committed || committed.catalogRevision !== this.#build.catalogRevision) {
      return false;
    }
    try {
      if (
        canonicalLocale(committed.locale.messageLocale) !== committed.locale.messageLocale ||
        canonicalLocale(committed.locale.formatLocale) !== committed.locale.formatLocale
      ) {
        return false;
      }
    } catch {
      return false;
    }
    const provisional = this.#provisionalInitialLocale;
    const preserveExplicitInitial =
      provisional?.source === 'explicit' &&
      (committed.locale.source !== 'explicit' ||
        committed.locale.formatLocale !== provisional.locale);
    if (provisional && !preserveExplicitInitial) {
      if (
        provisional.source === 'navigator' &&
        committed.locale.source === 'default' &&
        !sameMessageLanguage(provisional.locale, this.#build.sourceLocale)
      ) {
        return true;
      }
      this.#provisionalInitialLocale = null;
    }
    if (this.#desired) {
      if (committed.locale.revision < this.#desired.revision) {
        return false;
      }
      if (committed.locale.revision === this.#desired.revision) {
        return samePresentationLocale(committed.locale, this.#desired);
      }
    }
    this.#desired = committed.locale;
    const initialTransition = this.#explicitInitialTransition();
    this.#setTransition(
      initialTransition ?? {
        status: 'pending',
        messageLocale: committed.locale.messageLocale,
        formatLocale: committed.locale.formatLocale,
      },
    );
    return true;
  }

  receiveBundleReady(value: unknown): boolean {
    const ready = readBundleReady(value);
    const desired = this.#desired;
    if (
      !ready ||
      !desired ||
      ready.catalogRevision !== this.#build.catalogRevision ||
      ready.messageLocale !== desired.messageLocale ||
      ready.sessionLocaleRevision !== desired.revision ||
      ready.bundle.locale !== ready.messageLocale
    ) {
      return false;
    }
    try {
      if (
        canonicalLocale(ready.messageLocale) !== ready.messageLocale ||
        canonicalLocale(desired.formatLocale) !== desired.formatLocale
      ) {
        return false;
      }
      this.#assertCompleteMessages(ready.bundle.messages);
    } catch {
      return false;
    }
    const identity: LocalizationBundleIdentity = {
      catalogRevision: ready.catalogRevision,
      messageLocale: ready.messageLocale,
      sessionLocaleRevision: ready.sessionLocaleRevision,
    };
    this.#snapshot = {
      catalogRevision: this.#build.catalogRevision,
      messageLocale: ready.messageLocale,
      formatLocale: desired.formatLocale,
      messages: { ...ready.bundle.messages },
      direction: directionForLocale(desired.formatLocale),
      activeIdentity: identity,
      activationVersion: this.#snapshot.activationVersion + 1,
      transition: this.#explicitInitialTransition() ?? { status: 'idle' },
    };
    this.#emit();
    return true;
  }

  receiveSourceFallback(value: unknown): boolean {
    const fallback = readSourceFallback(value);
    const desired = this.#desired;
    if (
      fallback === null ||
      !desired ||
      fallback.catalogRevision !== this.#build.catalogRevision ||
      fallback.messageLocale !== desired.messageLocale ||
      fallback.sessionLocaleRevision !== desired.revision
    ) {
      return false;
    }
    if (this.#explicitInitialTransition()) {
      return true;
    }
    this.#setTransition({
      status: 'failed',
      messageLocale: desired.messageLocale,
      formatLocale: desired.formatLocale,
      reason: fallback.reason,
    });
    return true;
  }

  navigatorLocale(): string {
    const candidates = [...navigator.languages, navigator.language];
    for (const candidate of candidates) {
      try {
        return canonicalLocale(candidate);
      } catch {}
    }
    return this.#build.sourceLocale;
  }

  activeIdentity(): LocalizationBundleIdentity | undefined {
    const identity = this.#snapshot.activeIdentity;
    return identity ? { ...identity } : undefined;
  }

  acknowledgeInstalledActivation(
    renderedVersion: number,
    renderedIdentity: LocalizationBundleIdentity | null,
  ): Promise<void> {
    if (
      renderedVersion <= this.#lastAcknowledgedVersion ||
      !renderedIdentity ||
      !this.#activationSender
    ) {
      return Promise.resolve();
    }
    this.#pendingAcknowledgement = {
      version: renderedVersion,
      identity: { ...renderedIdentity },
    };
    if (this.#acknowledging) {
      return this.#acknowledging;
    }
    return this.#flushAcknowledgement();
  }

  #flushAcknowledgement(): Promise<void> {
    const pending = this.#pendingAcknowledgement;
    const sender = this.#activationSender;
    if (!pending || !sender) {
      return Promise.resolve();
    }
    this.#pendingAcknowledgement = null;
    this.#acknowledging = sender(pending.identity)
      .then((result) => {
        if (result.accepted) {
          this.#lastAcknowledgedVersion = Math.max(this.#lastAcknowledgedVersion, pending.version);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.#acknowledging = null;
        if (
          this.#pendingAcknowledgement &&
          this.#pendingAcknowledgement.version > this.#lastAcknowledgedVersion
        ) {
          void this.#flushAcknowledgement();
        }
      });
    return this.#acknowledging;
  }

  #assertCompleteMessages(messages: Record<string, string>): void {
    const ids = Object.keys(messages).sort();
    if (
      ids.length !== this.#sourceIds.length ||
      ids.some((id, index) => id !== this.#sourceIds[index]) ||
      Object.values(messages).some((message) => typeof message !== 'string' || message.length === 0)
    ) {
      throw new Error('Localization bundle is incomplete.');
    }
  }

  #explicitInitialTransition(): LocalizationTransition | null {
    const provisional = this.#provisionalInitialLocale;
    if (!provisional || provisional.source !== 'explicit') {
      return null;
    }
    return {
      status: 'pending',
      messageLocale: provisional.locale,
      formatLocale: provisional.locale,
    };
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #setTransition(transition: LocalizationTransition): void {
    this.#snapshot = { ...this.#snapshot, transition };
    this.#emit();
  }
}

export function directionForLocale(locale: string): TextDirection {
  const script = new Intl.Locale(canonicalLocale(locale)).maximize().script ?? '';
  return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
}

function canonicalLocale(locale: string): string {
  const locales = Intl.getCanonicalLocales(locale.trim());
  if (locales.length !== 1) {
    throw new Error('Expected one locale.');
  }
  return locales[0];
}

function sameMessageLanguage(left: string, right: string): boolean {
  const leftLocale = new Intl.Locale(left).maximize();
  const rightLocale = new Intl.Locale(right).maximize();
  return leftLocale.language === rightLocale.language && leftLocale.script === rightLocale.script;
}

function readCommitted(value: unknown): LocaleCommittedParams | null {
  if (!isRecord(value) || value['catalogRevision'] === undefined || !isRecord(value['locale'])) {
    return null;
  }
  const locale = value['locale'];
  if (
    typeof value['catalogRevision'] !== 'string' ||
    typeof locale['messageLocale'] !== 'string' ||
    typeof locale['formatLocale'] !== 'string' ||
    !isLocaleSource(locale['source']) ||
    !isRevision(locale['revision'])
  ) {
    return null;
  }
  return {
    catalogRevision: value['catalogRevision'],
    locale: {
      messageLocale: locale['messageLocale'],
      formatLocale: locale['formatLocale'],
      source: locale['source'],
      revision: locale['revision'],
    },
  };
}

function readBundleReady(value: unknown): LocaleBundleReadyParams | null {
  if (!isRecord(value) || !isRecord(value['bundle']) || !isRecord(value['bundle']['messages'])) {
    return null;
  }
  if (
    typeof value['catalogRevision'] !== 'string' ||
    typeof value['messageLocale'] !== 'string' ||
    !isRevision(value['sessionLocaleRevision']) ||
    typeof value['bundle']['locale'] !== 'string'
  ) {
    return null;
  }
  const messages = readMessages(value['bundle']['messages']);
  if (!messages) {
    return null;
  }
  return {
    catalogRevision: value['catalogRevision'],
    messageLocale: value['messageLocale'],
    sessionLocaleRevision: value['sessionLocaleRevision'],
    bundle: { locale: value['bundle']['locale'], messages },
  };
}

function readSourceFallback(value: unknown): LocaleSourceFallbackParams | null {
  if (
    !isRecord(value) ||
    typeof value['catalogRevision'] !== 'string' ||
    typeof value['messageLocale'] !== 'string' ||
    !isRevision(value['sessionLocaleRevision']) ||
    !isFallbackReason(value['reason']) ||
    (value['retryAfterMs'] !== undefined && !isRevision(value['retryAfterMs']))
  ) {
    return null;
  }
  return {
    catalogRevision: value['catalogRevision'],
    messageLocale: value['messageLocale'],
    sessionLocaleRevision: value['sessionLocaleRevision'],
    reason: value['reason'],
    ...(value['retryAfterMs'] === undefined ? {} : { retryAfterMs: value['retryAfterMs'] }),
  };
}

function readMessages(value: Record<string, unknown>): Record<string, string> | null {
  const messages: Record<string, string> = {};
  for (const [id, message] of Object.entries(value)) {
    if (id.length === 0 || typeof message !== 'string') {
      return null;
    }
    messages[id] = message;
  }
  return messages;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isLocaleSource(value: unknown): value is SessionPresentationLocale['source'] {
  return (
    value === 'default' || value === 'navigator' || value === 'conversation' || value === 'explicit'
  );
}

function isFallbackReason(value: unknown): value is LocaleSourceFallbackParams['reason'] {
  return (
    value === 'busy' ||
    value === 'rate-limited' ||
    value === 'generation-failed' ||
    value === 'storage-failed'
  );
}

function samePresentationLocale(
  left: SessionPresentationLocale,
  right: SessionPresentationLocale,
): boolean {
  return (
    left.messageLocale === right.messageLocale &&
    left.formatLocale === right.formatLocale &&
    left.source === right.source &&
    left.revision === right.revision
  );
}

function isActivePresentation(
  identity: LocalizationBundleIdentity | null,
  locale: SessionPresentationLocale,
): boolean {
  return (
    identity?.messageLocale === locale.messageLocale &&
    identity.sessionLocaleRevision === locale.revision
  );
}
