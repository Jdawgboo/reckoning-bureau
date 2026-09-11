import type { IntlConfig } from 'react-intl';

type IntlError = Parameters<NonNullable<IntlConfig['onError']>>[0];
type IntlErrorReporter = (error: IntlError) => void;

/** Keeps browser locale-data fallback separate from real message and configuration failures. */
export function handleIntlError(error: IntlError, report: IntlErrorReporter = console.error): void {
  if (error.code === 'MISSING_DATA') {
    return;
  }
  report(error);
}
