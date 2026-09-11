import { useIntl } from 'react-intl';
import { Button } from '@/app/lib/shadcdn/button.tsx';
import { displayLanguageName } from './display-language-name.ts';
import { messages } from './messages.ts';
import type { LocalizationSnapshot } from './localization-store.ts';

export function LocalizationStatus({
  snapshot,
  onRetry,
}: {
  snapshot: LocalizationSnapshot;
  onRetry: () => void;
}) {
  const intl = useIntl();
  const transition = snapshot.transition;
  if (transition.status !== 'failed') {
    return null;
  }

  const activeLanguageSelfName = intl.formatMessage(messages.localizationLanguageSelfName);
  const language = displayLanguageName(
    transition.messageLocale,
    snapshot.messageLocale,
    activeLanguageSelfName,
  );
  const activeLanguage = displayLanguageName(
    snapshot.messageLocale,
    snapshot.messageLocale,
    activeLanguageSelfName,
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-auto flex max-w-container-form items-center gap-2 rounded-xl border bg-background/95 px-3 py-2 text-sm text-foreground shadow-lg backdrop-blur"
      >
        <span>{intl.formatMessage(messages.localizationFailed, { language, activeLanguage })}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          {intl.formatMessage(messages.retry)}
        </Button>
      </div>
    </div>
  );
}
