import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createIntl, InvalidConfigError, MissingDataError } from 'react-intl';
import { handleIntlError } from './intl-error-handler.ts';

describe('handleIntlError', () => {
  it('accepts browser locale-data fallback without reporting a runtime failure', () => {
    const reports: Error[] = [];

    handleIntlError(new MissingDataError('Missing Georgian NumberFormat data.'), (error) => {
      reports.push(error);
    });

    assert.deepStrictEqual(reports, []);
  });

  it('contains the React Intl initialization diagnostic from an unsupported browser locale', () => {
    const originalSupportedLocalesOf = Intl.NumberFormat.supportedLocalesOf;
    const reports: Error[] = [];
    Intl.NumberFormat.supportedLocalesOf = () => [];

    try {
      createIntl({
        locale: 'ka',
        defaultLocale: 'en',
        messages: { home: 'მთავარი' },
        onError: (error) => handleIntlError(error, (reported) => reports.push(reported)),
      });
    } finally {
      Intl.NumberFormat.supportedLocalesOf = originalSupportedLocalesOf;
    }

    assert.deepStrictEqual(reports, []);
  });

  it('still reports non-recoverable React Intl failures', () => {
    const reports: Error[] = [];
    const error = new InvalidConfigError('Locale configuration is invalid.');

    handleIntlError(error, (reported) => {
      reports.push(reported);
    });

    assert.deepStrictEqual(reports, [error]);
  });
});
