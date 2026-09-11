import IntlMessageFormat, { type PrimitiveType } from 'intl-messageformat';
import type { LocalizationBundle } from '../../../shared/localization.ts';

export type LocalizationFormatValues = Record<string, PrimitiveType>;

/** Formats one stable server-owned message from a complete localization bundle. */
export class LocalizationFormatter {
  format(
    bundle: LocalizationBundle,
    formatLocale: string,
    messageId: string,
    values?: LocalizationFormatValues,
  ): string {
    const message = bundle.messages[messageId];
    if (message === undefined) {
      throw new Error(`Localization bundle does not contain message "${messageId}".`);
    }
    const formatted = new IntlMessageFormat(message, formatLocale).format<string>(values);
    if (typeof formatted === 'string') {
      return formatted;
    }
    if (Array.isArray(formatted) && formatted.every((part) => typeof part === 'string')) {
      return formatted.join('');
    }
    throw new Error(`Localization message "${messageId}" produced non-text server output.`);
  }
}
