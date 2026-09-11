const STORAGE_KEY = 'agentplace.explicit-locale.v1';

export interface LocalePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Reads the visitor's last explicit language choice for this agent origin.
 * Preview, published, and custom-domain agents have separate origins, so the
 * preference cannot leak between agents or become shared agent source.
 */
export function loadExplicitLocalePreference(storage?: LocalePreferenceStorage): string | null {
  return readExplicitLocalePreference(null, storage);
}

/** Re-reads the shared origin preference while preserving memory if storage is unavailable. */
export function refreshExplicitLocalePreference(
  currentLocale: string | null,
  storage?: LocalePreferenceStorage,
): string | null {
  return readExplicitLocalePreference(currentLocale, storage);
}

function readExplicitLocalePreference(
  unavailableFallback: string | null,
  storage?: LocalePreferenceStorage,
): string | null {
  try {
    const availableStorage = storage ?? localStorage;
    const stored = availableStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const locale = canonicalLocale(stored);
    if (!locale) {
      availableStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return locale;
  } catch {
    return unavailableFallback;
  }
}

/** Persists only a canonical locale that the visitor explicitly requested. */
export function saveExplicitLocalePreference(
  locale: string,
  storage?: LocalePreferenceStorage,
): boolean {
  const canonical = canonicalLocale(locale);
  if (!canonical) {
    return false;
  }
  try {
    const availableStorage = storage ?? localStorage;
    availableStorage.setItem(STORAGE_KEY, canonical);
    return true;
  } catch {
    return false;
  }
}

function canonicalLocale(locale: string): string | null {
  try {
    const canonical = Intl.getCanonicalLocales(locale.trim());
    return canonical.length === 1 ? canonical[0] : null;
  } catch {
    return null;
  }
}
