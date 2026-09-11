import type { LocalizationBundleIdentity } from '../../../../../shared/localization.ts';
import {
  LOCALE_BUNDLE_READY_METHOD,
  LOCALE_COMMITTED_METHOD,
  type LOCALE_SOURCE_FALLBACK_METHOD,
} from '../../../../../shared/ws-protocol.ts';
import type { LocalizationStore } from './localization-store.ts';
import {
  type LocalePreferenceStorage,
  loadExplicitLocalePreference,
  refreshExplicitLocalePreference,
  saveExplicitLocalePreference,
} from './explicit-locale-preference.ts';

type LocalizationNotificationMethod =
  | typeof LOCALE_COMMITTED_METHOD
  | typeof LOCALE_BUNDLE_READY_METHOD
  | typeof LOCALE_SOURCE_FALLBACK_METHOD;

interface LocalizationTransport {
  onLocalization(handler: (method: LocalizationNotificationMethod, params: unknown) => void): void;
  onSessionJoined(handler: () => void): void;
  localeHint(locale: string, activeBundle?: LocalizationBundleIdentity): Promise<unknown>;
  proposeLocale(locale: string): Promise<unknown>;
  activateLocale(identity: LocalizationBundleIdentity): Promise<{ accepted: boolean }>;
}

/** Connects one browser attachment to session locale events and its origin-local preference. */
export function wireLocalizationSession(
  store: LocalizationStore,
  transport: LocalizationTransport,
  storage?: LocalePreferenceStorage,
): void {
  let explicitPreference = loadExplicitLocalePreference(storage);

  transport.onLocalization((method, params) => {
    if (method === LOCALE_COMMITTED_METHOD) {
      if (store.receiveCommitted(params)) {
        const committedPreference = store.persistableExplicitLocale();
        if (committedPreference) {
          explicitPreference = committedPreference;
          saveExplicitLocalePreference(committedPreference, storage);
        }
      }
      return;
    }
    if (method === LOCALE_BUNDLE_READY_METHOD) {
      store.receiveBundleReady(params);
      return;
    }
    store.receiveSourceFallback(params);
  });

  transport.onSessionJoined(() => {
    explicitPreference = refreshExplicitLocalePreference(explicitPreference, storage);
    const source = explicitPreference ? 'explicit' : 'navigator';
    const candidate = explicitPreference ?? store.navigatorLocale();
    const locale = store.prepareInitialResolution(candidate, source);
    const request =
      source === 'explicit'
        ? transport.proposeLocale(locale)
        : transport.localeHint(locale, store.activeIdentity());
    void request.catch(() => store.cancelInitialResolution(locale, source));
  });

  store.setActivationSender((identity) => transport.activateLocale(identity));
  store.setResolutionRequester((locale, activeBundle) =>
    transport.localeHint(locale, activeBundle),
  );
}
