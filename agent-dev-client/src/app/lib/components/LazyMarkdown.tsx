import React, { Suspense } from 'react';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

const Markdown = React.lazy(() => import('./Markdown'));

type Props = {
  text: string;
  className?: string;
};

export const LazyMarkdown: React.FC<Props> = ({ text = '', className }) => {
  const intl = useIntl();
  return (
    <Suspense fallback={<small>{intl.formatMessage(messages.loading)}</small>}>
      {text && <Markdown text={text} className={className} />}
    </Suspense>
  );
};
