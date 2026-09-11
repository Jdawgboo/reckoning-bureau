import { createServer } from 'node:http';
import { DependencyContainer } from './container';
import { createWebSocketHandler, WsSessionManager, MessageProcessor } from './ws';
import { VoiceGateway } from './ws/voice-gateway';
import { ToolRegistryFactory } from './bl/messaging/tool-registry.factory';
import { RecordsClient, RecordsClientError } from './bl/records/records-client.ts';
import { VoiceUsageMeter } from './ws/voice-usage';
import { VoiceSessionHistoryClient } from './ws/voice-session-history';
import { createRequestHandler } from './http/request-handler';
import { createPlatformRouter } from './trpc/routers/platform.router';
import { createAppRouter } from './trpc/router';
import { installAgentLogger } from './util/agent-logger';
import { reportSurfaceContractProblems } from './bl/messaging/contract-diagnostics';
import { LOCALIZATION_BUILD } from 'virtual:agentplace-localization/server';
import { SessionLocalizationService } from './ws/session-localization.service.ts';

installAgentLogger();

export class Server {
  private container: DependencyContainer;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wsShutdown: (() => void) | null = null;

  constructor() {
    this.container = DependencyContainer.getInstance();
  }

  async start() {
    console.log('[Server] Starting Agent Dev Server...');
    reportSurfaceContractProblems();

    await this.container.setup();

    const sessionTtlMs = 24 * 60 * 60 * 1000;
    const localizationService = new SessionLocalizationService({
      build: LOCALIZATION_BUILD,
      resolver: this.container.createPlatformLocalizationClient(),
    });
    this.container.setLocalizationService(localizationService);
    const sessionManager = new WsSessionManager({
      ttlMs: sessionTtlMs,
      agentSessionManager: this.container.getSessionManager(),
      stateTree: this.container.getAgentState(),
      messageLocaleSelector: (formatLocale) =>
        localizationService.selectMessageLocale(formatLocale),
      onSessionCreated: async (session) => {
        console.log(`[Server] Session created: ${session.sessionKey}`);
      },
    });
    sessionManager.startCleanup();

    // Allow container to route trigger content through WsSessions
    this.container.setWsSessionManager(sessionManager);

    // Build tRPC routers once at startup
    const storageFactory = this.container.getAgentStorageFactoryService();
    const platformRouter = createPlatformRouter({ container: this.container, sessionManager });
    const appRouter = createAppRouter(platformRouter);

    // Create request handler — all HTTP routing lives inside
    const requestHandler = createRequestHandler({ sessionManager, container: this.container });

    this.httpServer = createServer(requestHandler);

    // Voice gateway shares the session manager and message processor with /ws
    // so spoken turns land on the same session as typed ones.
    const messageProcessor = new MessageProcessor({ container: this.container });
    const agentSessionManager = this.container.getSessionManager();
    const voiceGateway = new VoiceGateway({
      sessionManager,
      messageProcessor,
      relay: (() => {
        const baseUrl = this.container.settings.getSecret('MODEL_BASE_URL');
        const accessKey = this.container.settings.getSecret('MODEL_ACCESS_KEY');
        return baseUrl && accessKey ? { baseUrl, accessKey } : undefined;
      })(),
      usageMeter: new VoiceUsageMeter(this.container.getAgentState()),
      capabilities: ToolRegistryFactory.getCapabilityCard(),
      sessionHistory: agentSessionManager
        ? new VoiceSessionHistoryClient(agentSessionManager)
        : undefined,
      localizationService,
      logInteraction: async ({ sessionKey, kind, summary, durationMs }) => {
        // Records plane, log class. On a template with no `interactions`
        // declaration the guard denies the write — expected and silent, so the
        // horizontal template stays case-free; declaring the collection
        // activates logging with no code change.
        const records = new RecordsClient(this.container.getStateConnection()?.transport ?? null, {
          sessionId: sessionKey,
        });
        try {
          await records.create('interactions', undefined, {
            kind,
            summary,
            durationMs,
            channel: 'voice',
          });
        } catch (err) {
          if (!(err instanceof RecordsClientError)) {
            throw err;
          }
        }
      },
    });

    // Initialize WebSocket handler with tRPC router for WS-based procedure calls
    const { shutdown } = createWebSocketHandler({
      httpServer: this.httpServer,
      container: this.container,
      sessionManager,
      sessionTtlMs,
      appRouter,
      storageFactory,
      messageProcessor,
      localizationService,
      upgradeHandlers: [voiceGateway],
    });
    this.wsShutdown = () => {
      voiceGateway.shutdown();
      shutdown();
    };

    const PORT = this.container.settings.getSecret('DEV_SERVER_PORT') || 8090;
    this.httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] HTTP server listening on port ${PORT}`);
      console.log(`[Server] WebSocket available at ws://0.0.0.0:${PORT}/ws`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  private shutdown() {
    console.log('[Server] Shutting down...');
    this.container.stopAgentInstance().catch((err) => {
      console.error('[Server] Error stopping agent instance:', err);
    });
    this.container.getStateConnection()?.close();
    if (this.wsShutdown) {
      this.wsShutdown();
    }
    if (this.httpServer) {
      this.httpServer.close(() => {
        console.log('[Server] HTTP server closed');
        process.exit(0);
      });
    }
  }
}
