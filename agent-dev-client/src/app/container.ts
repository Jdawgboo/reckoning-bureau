import { FileReadingService, FileUploadService, LoggerService } from './lib/services';

import { MessagesStore } from './lib/messaging/MessagesStore';
import { SITE_CONFIG } from './agent/site-config';
import { buildPresentationContract } from './agent/presentation-contract';
import { NotificationStore } from './lib/messaging/NotificationsStore';
import { SettingsStore } from './lib/messaging/SettingsStore';
import { MemoryStore } from './lib/messaging/MemoryStore';
import { wsManager } from './lib/services/websocket-manager';
import { LOCALIZATION_BUILD } from 'virtual:agentplace-localization/client';
import { LocalizationStore } from './lib/localization/localization-store.ts';
import { wireLocalizationSession } from './lib/localization/localization-session-wiring.ts';

export interface Container {
  loggerService: LoggerService;
  messagesStore: MessagesStore;
  memoryStore: MemoryStore;
  fileReadingService: FileReadingService;
  fileUploadService: FileUploadService;
  settingsStore: SettingsStore;
  localizationStore: LocalizationStore;
}

export const buildContainer = async (): Promise<Container> => {
  const loggerService = new LoggerService({
    applicationName: 'agent-dev-client',
  });

  const memoryStore = new MemoryStore();
  const localizationStore = new LocalizationStore(LOCALIZATION_BUILD);
  wireLocalizationSession(localizationStore, wsManager);

  const messagesStore = new MessagesStore({
    notificationsStore: new NotificationStore(),
    memoryStore,
    presentation: buildPresentationContract(SITE_CONFIG),
  });

  const settingsStore = new SettingsStore(memoryStore);

  // Connect WebSocket before settings load — tRPC calls run over WebSocket (RpcPeer),
  // so the peer must be available before any tRPC queries fire.
  // wsManager.connect() is idempotent, so the later call in useChatRehydration is a no-op.
  await wsManager.connect();

  // Load settings before returning container - ensures memoryStore is initialized
  await settingsStore.load();

  const fileReadingService = new FileReadingService();
  const fileUploadService = new FileUploadService();

  return {
    loggerService,
    messagesStore,
    memoryStore,
    fileReadingService,
    fileUploadService,
    settingsStore,
    localizationStore,
  };
};
