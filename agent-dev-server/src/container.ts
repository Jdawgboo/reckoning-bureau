import Settings from './settings';
import { MessagingService } from './bl/messaging/messaging.service';
import { ToolRegistryFactory } from './bl/messaging/tool-registry.factory';
import type { SurfaceContractCatalog } from './ws/a2ui-click-resolver.ts';
import OpenAIAudioService from './services/openai-audio';
import type { ModelProvider } from './bl/agent/interfaces';
import { ModelProviderService } from './bl/agent/model-provider.service';
import { InstructionService } from './services/instruction.service';
import { AgentStorageFactoryService } from './services/agent-storage-factory.service';
import {
  AgentFactory,
  ToolLoopAgentRunner,
  DefaultPresenter,
  defaultPolicies,
  setLangfuseClient,
  StateConnection,
  RpcStateBackend,
  createAgent,
  createTextContent,
} from './bl/agent/agent-library';
import type {
  AgentInstance,
  TriggerEvent,
  TriggerContext,
  TriggerHandler,
  TriggerLlmOptions,
  TriggerLlmResult,
  TriggerRegistrationOptions,
  ScheduleEvent,
  ScheduleHandler,
  ScheduleLlmOptions,
  ScheduleLlmResult,
  ScheduleRegistrationOptions,
  OutboundChannelAdapter,
} from './bl/agent/agent-library';
import { agentModelId } from './bl/config-bridge.ts';
import { createContextManagement } from './bl/messaging/context-management.config';
import LangfuseService from './services/langfuse';
import { RpcPeer, WebSocketAdapter } from '../vendor/agentplace-transport/node';
import { MCPServerRegistry } from './bl/tools/mcp-server.registry';
import { getConfigId } from './util/config';
import type { WsSessionManager } from './ws/session-manager';
import { consumeContentStream } from './util/consume-content-stream';
import { consumeAguiStream } from './util/consume-agui-stream';
import { PlatformLocalizationClient } from './services/platform-localization-client.ts';
import type { SessionLocalizationService } from './ws/session-localization.service.ts';
import type { SessionLocaleRuntime } from './bl/messaging/session-locale-runtime.ts';
import { createSessionLocaleMiddleware } from './bl/messaging/agent-run-presentation.ts';
import { getSessionKey } from './bl/agent/agent-state.ts';
import { formatAgentUserMessage } from './services/server-localization-messages.ts';

/** Channel truth for automated runs, authored by this adapter — rides the
 *  `presentation` parameter (the same seam the web client uses). */
const HEADLESS_RUN_PRESENTATION = [
  '<presentation>',
  'No visitor is present in this automated run (trigger/schedule). Nothing you render is displayed live; a screen would only leave a markdown trace in the record. Do the work directly — write records and send notifications as the flow calls for, and answer in plain text.',
  '</presentation>',
].join('\n');

export class DependencyContainer {
  static INSTANCE: DependencyContainer;

  public settings: Settings;
  #wsSessionManager: WsSessionManager | null = null;
  #localizationService: SessionLocalizationService | null = null;

  setWsSessionManager(sm: WsSessionManager): void {
    this.#wsSessionManager = sm;
  }

  setLocalizationService(service: SessionLocalizationService): void {
    this.#localizationService = service;
  }

  private dependencies: {
    audioService: OpenAIAudioService;
    modelProvider: ModelProvider;
    agentFactory: AgentFactory;
    agentStorageFactoryService: AgentStorageFactoryService;
    stateConnection: StateConnection | null;
    agentInstance: AgentInstance | null;
    mcpServerRegistry: MCPServerRegistry;
  };

  static getInstance(): DependencyContainer {
    if (!DependencyContainer.INSTANCE) {
      DependencyContainer.INSTANCE = new DependencyContainer();
    }
    return DependencyContainer.INSTANCE;
  }

  async setup(): Promise<void> {
    this.settings = new Settings();
    await this.settings.load();

    const modelBaseUrl = this.settings.getSecret('MODEL_BASE_URL');
    const modelAccessKey = this.settings.getSecret('MODEL_ACCESS_KEY');

    if (!modelBaseUrl) {
      throw new Error(
        'MODEL_BASE_URL environment variable is required but not set. Please configure it in the Settings → Environment Variables panel.',
      );
    }

    if (!modelAccessKey) {
      throw new Error(
        'MODEL_ACCESS_KEY environment variable is required but not set. Please configure it in the Settings → Environment Variables panel.',
      );
    }

    // Audio service uses OpenAI via the gateway
    // Gateway injects the real API key, so we use a placeholder
    const gatewayBaseUrl = `${modelBaseUrl}/api/gateway`;
    const audioService = new OpenAIAudioService({
      connectionParams: {
        baseURL: `${gatewayBaseUrl}/openai/v1`,
        apiKey: 'gateway', // Placeholder - gateway injects real key
        defaultHeaders: {
          'X-Access-Key': modelAccessKey,
        },
      },
      enableAudioPreview: this.settings.getBooleanSecret('SHOULD_USE_AUDIO_PREVIEW_FOR_STT'),
      enableProcessing: this.settings.getBooleanSecret('SHOULD_PROCESS_AUDIO'),
    });

    const modelProvider = this.createModelProvider();

    const agentFactory = new AgentFactory({
      runner: new ToolLoopAgentRunner(),
      presenter: new DefaultPresenter(),
      policies: defaultPolicies,
    });

    const agentStorageFactoryService = new AgentStorageFactoryService({
      apiBaseUrl: modelBaseUrl,
      modelAccessToken: modelAccessKey,
    });

    // Routing exposes every storage branch as a virtual top-level directory.
    // `logs/` intentionally not mounted: it holds the control-server's builder
    // debug log, not agent data — mounting it let greps re-ingest the agent's
    // own logged tool outputs and exposed cross-session log content.
    agentStorageFactoryService.setInfraConfig(
      [{ name: 'source', basePath: '/opt/agentplace/agent/.agent' }],
      {
        'source/': 'source',
        'tool-results/': 'tool-results',
        'private/': 'private',
        'common/': 'common',
      },
    );

    this.configureTracing(modelBaseUrl, modelAccessKey);

    const mcpServerRegistry = new MCPServerRegistry();

    // Create the agent instance with event pipeline (channels, triggers, delivery)
    const stateConnection = this.createStateConnection();
    const agentInstance = await this.createAgentInstance(
      stateConnection,
      modelProvider,
      agentStorageFactoryService,
      mcpServerRegistry,
    );

    this.dependencies = {
      modelProvider,
      audioService,
      agentFactory,
      agentStorageFactoryService,
      mcpServerRegistry,
      stateConnection,
      agentInstance,
    };

    this.registerBureauSchedules();

    // Start event processing in background (non-blocking)
    if (agentInstance) {
      agentInstance.listen().catch((err) => {
        console.error('[Container] Failed to start event processing:', err);
      });
    }

    console.log('[Container] Setup complete.');
  }

  /**
   * The Bureau's escalation clock.
   *
   * A demand carries a deadline, and a deadline that nobody watches is theatre.
   * When the agent issues a demand it creates an `at` schedule on this handler
   * with `{ docket }`; when the date arrives the handler wakes the office and
   * lets the agent run the escalation itself (read the file, ask the claimant
   * whether anything came back, put the next lever in front of them).
   *
   * Deterministic parts stay here: the fired-once guard in durable state, so a
   * replay after VM sleep cannot re-open the same escalation twice, and the
   * thin prompt — the workflow itself belongs to the agent.
   */
  private registerBureauSchedules(): void {
    this.registerSchedule('escalation_review', async (event, ctx) => {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const docket = typeof params.docket === 'string' ? params.docket : null;
      console.log('[escalation_review] fired:', {
        docket,
        scheduledAt: event.scheduledAt,
        delayedByHours: event.delayedByHours,
      });
      if (!docket) {
        console.error('[escalation_review] no docket in params; nothing to review');
        return;
      }
      try {
        const guardPath = `/data/escalations/${docket}`;
        const guard = (await ctx.state.get(guardPath)) as { firedFor?: unknown } | null;
        if (guard && guard.firedFor === event.scheduledAt) {
          console.log(`[escalation_review] ${docket} already reviewed for ${event.scheduledAt}`);
          return;
        }
        await ctx.state.set(guardPath, {
          firedFor: event.scheduledAt,
          reviewedAt: new Date().toISOString(),
        });
        await ctx.llm({
          message:
            `[escalation-clock] The response deadline on case ${docket} has expired. ` +
            `Read common/cases/${docket}.json, then take the escalation to the claimant: ` +
            'ask whether anything came back, and put the next lever in front of them.',
        });
      } catch (error) {
        console.error(`[escalation_review] failed for ${docket}:`, error);
      } finally {
        console.log('[escalation_review] done:', docket);
      }
    });
  }

  createMessagingService() {
    return new MessagingService({
      audioService: this.dependencies.audioService,
      modelProvider: this.dependencies.modelProvider,
      instructionService: this.createInstructionService(),
      agentFactory: this.dependencies.agentFactory,
      storageFactory: this.dependencies.agentStorageFactoryService,
      mcpRegistry: this.dependencies.mcpServerRegistry,
      sessionManager: this.dependencies.agentInstance?.sessionManager ?? null,
      stateTree: this.getAgentState(),
      recordsTransport: this.dependencies.stateConnection?.transport ?? null,
      getSessionLocaleRuntime: (sessionKey, attachmentId) =>
        this.#sessionLocaleRuntime(sessionKey, attachmentId),
    });
  }

  private createModelProvider(): ModelProvider {
    const gatewayBaseUrl = `${this.settings.getSecret('MODEL_BASE_URL')}/api/gateway`;
    return new ModelProviderService({
      baseUrl: gatewayBaseUrl,
      accessKey: this.settings.getSecret('MODEL_ACCESS_KEY'),
    });
  }

  createInstructionService(): InstructionService {
    return new InstructionService();
  }

  createPlatformLocalizationClient(): PlatformLocalizationClient {
    return new PlatformLocalizationClient({
      apiBaseUrl: this.settings.getSecret('MODEL_BASE_URL'),
      accessKey: this.settings.getSecret('MODEL_ACCESS_KEY'),
    });
  }

  /** Surface contracts keyed by component name, for resolving a control on a rendered screen. */
  getSurfaceContracts(): SurfaceContractCatalog {
    return ToolRegistryFactory.getSurfaceContracts();
  }

  getAgentStorageFactoryService(): AgentStorageFactoryService {
    return this.dependencies.agentStorageFactoryService;
  }

  getStateConnection(): StateConnection | null {
    return this.dependencies.stateConnection;
  }

  getAgentState() {
    return this.dependencies.agentInstance?.state ?? null;
  }

  getSessionManager() {
    return this.dependencies.agentInstance?.sessionManager ?? null;
  }

  getEventProcessor() {
    return this.dependencies.agentInstance?.eventProcessor ?? null;
  }

  /** Stop the agent instance (event processor + delivery service + state). */
  async stopAgentInstance(): Promise<void> {
    await this.dependencies.agentInstance?.stop();
  }

  /**
   * Register a typed trigger handler for external events (Composio triggers).
   *
   * Three modes:
   * 1. Code-only — handler processes the event, does not invoke the LLM
   * 2. Code + LLM — handler calls ctx.llm() to invoke the LLM and uses the response
   * 3. LLM fallback — no handler registered, event is sent to LLM automatically
   *
   * @example
   * // Code-only: store data, no LLM tokens burned
   * container.registerTrigger('github_star_created', async (event, ctx) => {
   *   await ctx.state.set(`/data/stars/${event.eventId}`, event.payload);
   * });
   *
   * // Code + LLM: handler stays in control
   * container.registerTrigger('github_issue_created', async (event, ctx) => {
   *   const issue = event.payload;
   *   const { text } = await ctx.llm({
   *     message: `Classify this issue and suggest a priority: ${issue.title}\n${issue.body}`,
   *   });
   *   await ctx.state.set(`/data/issues/${issue.number}`, { ...issue, classification: text });
   * });
   */
  registerTrigger(
    triggerName: string,
    handler: TriggerHandler,
    options?: TriggerRegistrationOptions,
  ): void {
    if (!this.dependencies.agentInstance) {
      console.warn('[Container] Cannot register trigger: agent instance not initialized');
      return;
    }
    this.dependencies.agentInstance.registerTrigger(triggerName, handler, options);
  }

  /**
   * Register a schedule handler for scheduled task events.
   *
   * Code handlers run when the platform fires a schedule event matching this name.
   * Use for deterministic tasks (API checks, data sync). For conversational tasks,
   * use `__default` handler (LLM fallback) — no registration needed.
   *
   * @example
   * container.registerSchedule('health_check', async (event, ctx) => {
   *   const result = await fetch('https://api.example.com/health');
   *   if (!result.ok) {
   *     await ctx.llm({ message: 'API health check failed, summarize the error' });
   *   }
   * });
   */
  registerSchedule(
    handlerName: string,
    handler: ScheduleHandler,
    options?: ScheduleRegistrationOptions,
  ): void {
    if (!this.dependencies.agentInstance) {
      console.warn('[Container] Cannot register schedule handler: agent instance not initialized');
      return;
    }
    this.dependencies.agentInstance.registerSchedule(handlerName, handler, options);
  }

  /** Register an outbound channel adapter for delivery. */
  registerChannelAdapter(adapter: OutboundChannelAdapter): void {
    if (!this.dependencies.agentInstance) {
      console.warn('[Container] Cannot register adapter: agent instance not initialized');
      return;
    }
    this.dependencies.agentInstance.registerChannelAdapter(adapter);
  }

  /**
   * Create the AgentInstance with event pipeline.
   * Uses createAgent() from agent-library — wires state, sessions, triggers, channels, delivery.
   *
   * The `buildRuntimeTools` hook gives every agent run (channels, triggers,
   * schedules, and direct instance.run calls) access to the full platform tool
   * set — MCP servers, web search, NanoBanana, UseAgent, etc. Before this hook
   * existed, those flows only had agent-library built-ins, which is why
   * channel messages silently missed MCP tools.
   */
  private async createAgentInstance(
    stateConnection: StateConnection | null,
    modelProvider: ModelProvider,
    storageFactory: AgentStorageFactoryService,
    mcpRegistry: MCPServerRegistry,
  ): Promise<AgentInstance | null> {
    if (!stateConnection) {
      console.warn('[Container] AgentInstance not initialized: no StateConnection');
      return null;
    }

    const backend = new RpcStateBackend(stateConnection.transport);
    const modelId = agentModelId();
    const model = await modelProvider.getModel(modelId);
    const instruction = this.createInstructionService().getInstruction() || '';
    const gatewayBaseUrl = `${storageFactory.getApiBaseUrl()}/api/gateway`;

    const agent = createAgent({
      model,
      instructions: instruction,
      sessions: { backend },
      buildRuntimeTools: (ctx) =>
        ToolRegistryFactory.createPlatformTools(
          modelId,
          modelProvider,
          storageFactory,
          mcpRegistry,
          undefined,
          ctx.sessionId,
          ctx.state,
          stateConnection.transport,
          {
            sessionLocale: this.#sessionLocaleRuntime(ctx.sessionId),
          },
        ),
      buildRunConfig: (ctx) => {
        const storage = storageFactory.getStorage(ctx.sessionId);
        const contextManagement = createContextManagement({
          compactionScope: 'main',
          modelName: modelId,
          storage,
          sessionKey: ctx.sessionId,
          modelProvider,
          gatewayBaseUrl,
          accessKey: storageFactory.getAccessKey(),
        });
        const localeMiddleware = createSessionLocaleMiddleware(
          this.#sessionLocaleRuntime(ctx.sessionId),
        );
        return {
          modelMiddlewares: [
            ...contextManagement.modelMiddlewares,
            ...(localeMiddleware ? [localeMiddleware] : []),
          ],
          fileFirstConfig: contextManagement.fileFirstConfig,
          agentStorage: storage,
        };
      },
      resolveUserMessage: (code, state) => {
        const sessionKey = getSessionKey(state);
        const locale = sessionKey ? this.#sessionLocaleRuntime(sessionKey) : undefined;
        return formatAgentUserMessage(locale, code);
      },
      triggerLlm: (options, event, sessionId) => this.#triggerLlm(options, event, sessionId),
      onUnhandledTrigger: (event: TriggerEvent, sessionId?: string) => {
        this.#handleUnhandledTrigger(event, sessionId);
      },
      scheduleLlm: (options, event, sessionId) => this.#scheduleLlm(options, event, sessionId),
      onUnhandledSchedule: (event: ScheduleEvent, sessionId?: string) => {
        this.#handleUnhandledSchedule(event, sessionId);
      },
    });

    console.log('[Container] AgentInstance created');
    return agent;
  }

  #sessionLocaleRuntime(
    sessionKey: string | undefined,
    attachmentId?: string,
  ): SessionLocaleRuntime | undefined {
    if (!sessionKey) {
      return undefined;
    }
    const session = this.#wsSessionManager?.get(sessionKey);
    const localization = this.#localizationService;
    if (!session || !localization) {
      return undefined;
    }
    return {
      current: () => session.presentationLocale,
      propose: (locale, source) => localization.propose(session, locale, source),
      stableUi: (locale) =>
        session.localizationStatus(
          {
            catalogRevision: localization.catalogRevision,
            messageLocale: locale.messageLocale,
            sessionLocaleRevision: locale.revision,
          },
          attachmentId,
        ),
      format: (messageId, values) =>
        localization.format(session.presentationLocale, messageId, values),
    };
  }

  /**
   * Platform-specific ctx.llm() implementation for trigger handlers.
   * Uses MessagingService so the LLM has access to MCP tools.
   */
  async #triggerLlm(
    options: TriggerLlmOptions,
    event: TriggerEvent,
    sessionId?: string,
  ): Promise<TriggerLlmResult> {
    const messagingService = this.createMessagingService();
    const sid = sessionId ?? `trigger-${event.triggerId || event.eventId}-${Date.now()}`;
    const triggerLabel = event.triggerName.replace(/_/g, ' ');
    const sessionName = `${event.provider}: ${triggerLabel}`;
    const instruction = this.createInstructionService().getInstruction() || '';
    const configId = getConfigId(this);

    const result = await messagingService.sendMessage({
      configId,
      message: { type: 'TXT', content: options.message },
      instruction,
      presentation: HEADLESS_RUN_PRESENTATION,
      sessionKey: sid,
      sessionType: 'trigger',
      sessionName,
    });

    let text = '';
    const responseId = result.id;
    if (this.#wsSessionManager) {
      const wsSession = await this.#wsSessionManager.getOrCreate(sid, {
        userId: 'trigger',
        configId,
      });

      const userContent = createTextContent({
        messageId: `trigger-user-${responseId}`,
        content: options.message,
        role: 'user',
      });
      wsSession.broadcastContent({ ...userContent, responseId });
      wsSession.pushContent(userContent);

      const aguiDone = consumeAguiStream(wsSession, result.agui, responseId);
      for await (const content of result.stream) {
        if ('content' in content && typeof content.content === 'string') {
          text += content.content;
        }
        wsSession.broadcastContent({ ...content, responseId });
        wsSession.pushContent(content);
      }
      wsSession.broadcastContent({ type: 'finish', messageId: 'finish', responseId });
      await aguiDone;
    } else {
      for await (const content of result.stream) {
        if ('content' in content && typeof content.content === 'string') {
          text += content.content;
        }
      }
    }

    return { text };
  }

  /**
   * Platform-specific LLM fallback for unhandled triggers.
   * Uses MessagingService for full platform features (skills, audio, files).
   */
  async #handleUnhandledTrigger(event: TriggerEvent, resolvedSessionId?: string): Promise<void> {
    console.log('[Container] Handling trigger — starting agent run', {
      eventId: event.eventId,
      triggerName: event.triggerName,
      provider: event.provider,
      triggerId: event.triggerId,
      sessionId: resolvedSessionId,
    });
    // Format trigger as text for LLM processing — strip infrastructure fields
    const triggerData: Record<string, unknown> = {
      trigger_name: event.triggerName,
      provider: event.provider,
      timestamp: event.timestamp,
      data: event.payload,
    };
    const message = `[composio-trigger]\n${JSON.stringify(triggerData, null, 2)}`;

    try {
      const messagingService = this.createMessagingService();
      const sessionId =
        resolvedSessionId ?? `trigger-${event.triggerId || event.eventId}-${Date.now()}`;
      const triggerLabel = event.triggerName.replace(/_/g, ' ');
      const sessionName = `${event.provider}: ${triggerLabel}`;

      const instruction = this.createInstructionService().getInstruction() || '';

      const configId = getConfigId(this);

      const result = await messagingService.sendMessage({
        configId,
        message: { type: 'TXT', content: message },
        instruction,
        presentation: HEADLESS_RUN_PRESENTATION,
        sessionKey: sessionId,
        sessionType: 'trigger',
        sessionName,
      });

      // Route content through WsSession so connected browser clients see it
      // and the replay buffer captures it for later content.resume calls.
      const responseId = result.id;
      if (this.#wsSessionManager) {
        const wsSession = await this.#wsSessionManager.getOrCreate(sessionId, {
          userId: 'trigger',
          configId,
        });

        // Push user message (trigger payload) to replay buffer + broadcast,
        // matching what MessageProcessor does for normal WS messages.
        // Without this, content.resume only returns the LLM response and
        // the trigger input is missing until a full reload reconstructs
        // from persistent conversation history.
        const userContent = createTextContent({
          messageId: `trigger-user-${responseId}`,
          content: message,
          role: 'user',
        });
        wsSession.broadcastContent({ ...userContent, responseId });
        wsSession.pushContent(userContent);

        await Promise.all([
          consumeContentStream(wsSession, result.stream, responseId),
          consumeAguiStream(wsSession, result.agui, responseId),
        ]);
      } else {
        // No WsSessionManager — just drain
        for await (const _content of result.stream) {
          // drain
        }
      }
      console.log('[Container] Agent run completed for trigger', {
        eventId: event.eventId,
        sessionId,
      });
    } catch (err) {
      console.error('[Container] LLM fallback for trigger failed:', err);
    }
  }

  /**
   * Platform-specific ctx.llm() implementation for schedule handlers.
   * Uses MessagingService so the LLM has access to MCP tools.
   */
  async #scheduleLlm(
    options: ScheduleLlmOptions,
    event: ScheduleEvent,
    sessionId?: string,
  ): Promise<ScheduleLlmResult> {
    const messagingService = this.createMessagingService();
    const sid = sessionId ?? `cron-${event.taskId}-run-${event.eventId}`;
    const sessionName = `Schedule: ${event.taskId}`;
    const instruction = this.createInstructionService().getInstruction() || '';
    const configId = getConfigId(this);

    const result = await messagingService.sendMessage({
      configId,
      message: { type: 'TXT', content: options.message },
      instruction,
      presentation: HEADLESS_RUN_PRESENTATION,
      sessionKey: sid,
      sessionType: 'schedule',
      sessionName,
    });

    let text = '';
    const responseId = result.id;
    if (this.#wsSessionManager) {
      const wsSession = await this.#wsSessionManager.getOrCreate(sid, {
        userId: 'cron',
        configId,
      });

      const userContent = createTextContent({
        messageId: `cron-user-${responseId}`,
        content: options.message,
        role: 'user',
      });
      wsSession.broadcastContent({ ...userContent, responseId });
      wsSession.pushContent(userContent);

      const aguiDone = consumeAguiStream(wsSession, result.agui, responseId);
      for await (const content of result.stream) {
        if ('content' in content && typeof content.content === 'string') {
          text += content.content;
        }
        wsSession.broadcastContent({ ...content, responseId });
        wsSession.pushContent(content);
      }
      wsSession.broadcastContent({ type: 'finish', messageId: 'finish', responseId });
      await aguiDone;
    } else {
      for await (const content of result.stream) {
        if ('content' in content && typeof content.content === 'string') {
          text += content.content;
        }
      }
    }

    return { text };
  }

  /**
   * Platform-specific LLM fallback for unhandled schedule events (__default handler).
   * Uses MessagingService for full platform features (skills, MCP tools, audio, files).
   * Injects delayedByHours context when the task fired late.
   */
  async #handleUnhandledSchedule(event: ScheduleEvent, resolvedSessionId?: string): Promise<void> {
    console.log('[Container] Handling schedule — starting agent run', {
      eventId: event.eventId,
      taskId: event.taskId,
      handler: event.handler,
      sessionId: resolvedSessionId,
      delayedByHours: event.delayedByHours,
    });

    let message = (event.params.message as string) || `Scheduled task: ${event.taskId}`;
    if (event.delayedByHours) {
      message += `\n(Note: this task was scheduled for ${event.scheduledAt} but is being delivered ~${event.delayedByHours.toFixed(1)}h late due to a system delay.)`;
    }

    try {
      const messagingService = this.createMessagingService();
      const sessionId = resolvedSessionId ?? `cron-${event.taskId}-run-${event.eventId}`;
      const sessionName = `Schedule: ${event.taskId}`;
      const instruction = this.createInstructionService().getInstruction() || '';
      const configId = getConfigId(this);

      const result = await messagingService.sendMessage({
        configId,
        message: { type: 'TXT', content: message },
        instruction,
        presentation: HEADLESS_RUN_PRESENTATION,
        sessionKey: sessionId,
        sessionType: 'schedule',
        sessionName,
      });

      const responseId = result.id;
      if (this.#wsSessionManager) {
        const wsSession = await this.#wsSessionManager.getOrCreate(sessionId, {
          userId: 'cron',
          configId,
        });

        const userContent = createTextContent({
          messageId: `cron-user-${responseId}`,
          content: message,
          role: 'user',
        });
        wsSession.broadcastContent({ ...userContent, responseId });
        wsSession.pushContent(userContent);

        await Promise.all([
          consumeContentStream(wsSession, result.stream, responseId),
          consumeAguiStream(wsSession, result.agui, responseId),
        ]);
      } else {
        for await (const _content of result.stream) {
          // drain
        }
      }
      console.log('[Container] Agent run completed for schedule', {
        eventId: event.eventId,
        taskId: event.taskId,
        sessionId,
      });
    } catch (err) {
      console.error('[Container] LLM fallback for schedule failed:', err);
    }
  }

  private createStateConnection(): StateConnection | null {
    const platformUrl = this.settings.getSecret('MODEL_BASE_URL');
    const agentToken = this.settings.getSecret('MODEL_ACCESS_KEY');
    if (!platformUrl || !agentToken) {
      console.warn(
        '[Container] StateConnection not initialized: missing MODEL_BASE_URL or MODEL_ACCESS_KEY',
      );
      return null;
    }

    const wsBase = platformUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/api/agents/state/ws?token=${encodeURIComponent(agentToken)}`;

    const adapter = new WebSocketAdapter({ url: wsUrl, reconnectDelay: 2000 });
    const rpcPeer = new RpcPeer(adapter);

    console.log('[Container] Initializing StateConnection');
    return new StateConnection({ transport: rpcPeer, adapter });
  }

  getMcpServerRegistry(): MCPServerRegistry {
    return this.dependencies.mcpServerRegistry;
  }

  private configureTracing(modelBaseUrl: string, modelAccessKey: string): void {
    const tracesBaseUrl = `${modelBaseUrl}/traces`;
    const langfuseService = new LangfuseService({
      apiKey: modelAccessKey,
      appName: this.settings.getAppName(),
      baseUrl: tracesBaseUrl,
    });

    setLangfuseClient(langfuseService.getClient());
    console.log(`[Tracing] Langfuse orchestrator configured via ${tracesBaseUrl}`);
  }
}
