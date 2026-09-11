import type { SessionPresentationLocale } from '../../../../shared/index.ts';
import type { StableUiLocalizationStatus } from '../../ws/agent-session.ts';
import type { LocalizationFormatValues } from '../../services/localization-formatter.ts';

export interface SessionLocaleRuntime {
  current(): SessionPresentationLocale;
  propose(locale: string, source: 'explicit' | 'conversation'): Promise<SessionPresentationLocale>;
  stableUi(locale: SessionPresentationLocale): StableUiLocalizationStatus;
  format(messageId: string, values?: LocalizationFormatValues): string;
}
