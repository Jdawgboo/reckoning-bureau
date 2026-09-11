import type { FC, PropsWithChildren } from 'react';

import { ServicesContext } from '../contexts';
import { AudioRecorderProvider } from '../contexts/recorder';
import type { Container } from '../../container';
import { MessagesStoreProvider } from '../hooks/useMessagingStore';

type Props = {
  container: Container;
};

export const AppRoot: FC<PropsWithChildren<Props>> = ({ children, container }) => {
  return (
    <ServicesContext.Provider value={container}>
      <AudioRecorderProvider>
        <MessagesStoreProvider store={container.messagesStore}>{children}</MessagesStoreProvider>
      </AudioRecorderProvider>
    </ServicesContext.Provider>
  );
};
