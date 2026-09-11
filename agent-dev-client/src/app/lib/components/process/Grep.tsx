import type { FC } from 'react';
import { observer } from 'mobx-react-lite';
import type { AsArgumentsProps } from '@/app/lib/types';
import { cn } from '@/app/lib/utils';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type GrepProps = {
  totalMatches?: number;
  error?: string;
};

const GrepComponent: FC<AsArgumentsProps<GrepProps>> = observer(({ argumentsProps, toolPart }) => {
  const state = toolPart?.streaming?.state;
  const isDone = state === 'output-available' || state === 'output-error';
  const { totalMatches = 0, error } = argumentsProps || {};
  const intl = useIntl();

  const text = (() => {
    if (!isDone) return intl.formatMessage(messages.searchingFiles);
    if (error) return error;
    return totalMatches === 0
      ? intl.formatMessage(messages.noMatches)
      : intl.formatMessage(messages.matchesFound, { count: totalMatches });
  })();

  return (
    <div className="flex items-center py-2">
      <span className={cn('text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
        {text}
      </span>
    </div>
  );
});

export default GrepComponent;
