function formatLanguageName(locale: string, displayLocale: string): string | undefined {
  const [supportedLocale] = Intl.DisplayNames.supportedLocalesOf([displayLocale]);
  if (!supportedLocale) {
    return undefined;
  }
  return new Intl.DisplayNames([supportedLocale], { type: 'language' }).of(locale);
}

/** Formats a locale name for the surrounding UI, then falls back to its autonym. */
export function displayLanguageName(
  locale: string,
  displayLocale: string,
  displayLocaleSelfName?: string,
): string {
  try {
    const target = Intl.getCanonicalLocales(locale)[0];
    const display = Intl.getCanonicalLocales(displayLocale)[0];
    if (target === display && displayLocaleSelfName) {
      return displayLocaleSelfName;
    }
    const localized = formatLanguageName(target, display);
    if (localized) {
      const displayLanguage = new Intl.Locale(display).language;
      if (displayLanguage === 'en') {
        return localized;
      }
      const english = formatLanguageName(target, 'en');
      if (localized !== english) {
        return localized;
      }
    }
    return formatLanguageName(target, target) ?? locale;
  } catch {
    return locale;
  }
}
