import type { PropsWithChildren } from 'react';
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react';
import { IntlProvider } from 'react-intl';
import type { LocalizationSnapshot, LocalizationStore } from './localization-store.ts';
import { handleIntlError } from './intl-error-handler.ts';
import { LocalizationStatus } from './LocalizationStatus.tsx';

const LocalizationContext = createContext<LocalizationSnapshot | null>(null);

export function useLocalization(): LocalizationSnapshot {
  const localization = useContext(LocalizationContext);
  if (!localization) {
    throw new Error('useLocalization must be used within LocalizationProvider.');
  }
  return localization;
}

export function LocalizationProvider({
  children,
  store,
}: PropsWithChildren<{ store: LocalizationStore }>) {
  const localization = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(() => {
    document.documentElement.lang = localization.messageLocale;
    document.documentElement.dir = localization.direction;
    void store.acknowledgeInstalledActivation(
      localization.activationVersion,
      localization.activeIdentity,
    );
  }, [
    localization.activationVersion,
    localization.activeIdentity,
    localization.direction,
    localization.formatLocale,
    localization.messageLocale,
    store,
  ]);

  return (
    <LocalizationContext.Provider value={localization}>
      <IntlProvider
        locale={localization.formatLocale}
        defaultLocale={store.sourceLocale}
        messages={localization.messages}
        onError={handleIntlError}
      >
        {children}
        <LocalizationStatus snapshot={localization} onRetry={() => void store.retryResolution()} />
      </IntlProvider>
    </LocalizationContext.Provider>
  );
}
