import type { FC } from 'react';
import { CenterContentView } from '../CenterContentView';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export const AgentNotFoundComponent: FC = () => {
  const intl = useIntl();
  return (
    <CenterContentView>
      <div className="text-center">
        <h1 className="text-2xl flex-center mb-2">
          ⚠️ {intl.formatMessage(messages.agentNotFoundTitle)}
        </h1>
        <p className="text-base">{intl.formatMessage(messages.agentNotFoundBody)}</p>
      </div>
    </CenterContentView>
  );
};
