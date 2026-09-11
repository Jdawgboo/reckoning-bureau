/**
 * createAgent — high-level factory for building agents with zero boilerplate.
 *
 * Wires up state backend, session manager, event pipeline, channel handling,
 * and delivery service with sensible defaults. Power users can override any piece.
 *
 * @example
 * ```typescript
 * import { createAgent } from '@agentplace/agent';
 * import { anthropic } from '@ai-sdk/anthropic';
 *
 * const agent = createAgent({
 *   model: anthropic('claude-sonnet-4-6'),
 *   instructions: 'You are a helpful assistant.',
 *   tools: [weatherTool, searchTool],
 * });
 *
 * // Simple one-shot
 * const { text } = await agent.run({ query: 'What is the weather?' });
 *
 * // With session persistence (history loads/saves automatically)
 * const result = await agent.run({ query: 'Hello', sessionId: 'chat-1' });
 *
 * // Streaming
 * const handle = await agent.runStream({ query: 'Tell me a story', sessionId: 'chat-1' });
 * for await (const chunk of handle.stream) {
 *   // render chunk
 * }
 *
 * // With channels — listen for messages from Slack, Telegram, etc.
 * agent.registerTrigger('github_star', async (event, ctx) => { ... });
 * await agent.listen();
 * ```
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import Agent, { type AgentParamsT, type AgentRunInput } from './core/agent.ts';
import type { AgentRunOutcome } from './core/agent.service.ts';
import type AgentState from './core/agent-state.ts';
import { InMemoryStateBackend } from './state/in-memory-state-backend.ts';
import { StateTree } from './state/state-tree.ts';
import { SessionManager } from './sessions/session-manager.ts';
import { ToolRegistry } from './tools/tool-registry.ts';
import type { ToolModel } from './tools/tool-model.ts';
import type { KernelModelMiddleware } from './kernel/middlewares/types.ts';
import type { FileFirstConfig } from './core/file-first-offloader.ts';
import type { AgentStorage } from './storage/agent-storage.ts';
import type { TurnProcessor } from './kernel/processors/types.ts';
import type { StopPolicy, RetryPolicy, TurnPolicy } from './kernel/policies.ts';
import type { AgentRunner } from './runners/agent-runner.ts';
import type { KernelPresenter } from './kernel/presenter.ts';
import type { TraceOrchestrator } from './telemetry/trace-orchestrator.ts';
import type { AgentKernelEventSink } from './kernel/events.ts';
import type { StateBackend } from './state/types.ts';
import { ContentType, type AgentContent } from './types/content.ts';
import type { AgentRunHandle } from './kernel/run-handle.ts';
import { TriggerRouter } from './events/trigger-router.ts';
import { TriggerDispatcher } from './events/trigger-dispatcher.ts';
import { ScheduleRouter } from './events/schedule-router.ts';
import { ScheduleDispatcher } from './events/schedule-dispatcher.ts';
import { EventProcessor } from './events/event-processor.ts';
import { ChannelHandler } from './events/channel-handler.ts';
import { DeliveryService, type OutboundChannelAdapter } from './events/delivery-service.ts';
import { InboxReconciler } from './events/inbox-reconciler.ts';
import type {
  TriggerHandler,
  TriggerLlmFunction,
  TriggerRegistrationOptions,
  UnhandledTriggerCallback,
} from './events/types.ts';
import type {
  ScheduleHandler,
  ScheduleLlmFunction,
  ScheduleRegistrationOptions,
  UnhandledScheduleCallback,
} from './events/schedule-types.ts';
import { getBuiltInTools, filterScheduleSafeTools } from './tools/built-in-tools.ts';
import type { SessionType } from './sessions/types.ts';

/**
 * Context passed to `buildRuntimeTools` — the per-run hook used to assemble
 * dynamic tools (MCP servers, provider-conditional web search, platform-specific
 * tools, etc.) that can vary from one run to the next.
 */
export interface BuildRuntimeToolsContext {
  /** Agent state tree (for tools that need persistence). */
  state: StateTree;
  /** Session ID if the run is inside a session. */
  sessionId?: string;
  /** Session type ('web' | 'channel' | 'trigger' | 'schedule' | ...). */
  sessionType?: SessionType;
}

export type BuildRuntimeToolsFn = (
  ctx: BuildRuntimeToolsContext,
) => Promise<ToolModel[]> | ToolModel[];

/**
 * Run-scoped overrides returned by `AgentConfig.buildRunConfig`. When
 * `modelMiddlewares` is set, it REPLACES `AgentConfig.modelMiddlewares` for
 * that run (not merged).
 */
export type AgentRunConfigOverrides = {
  modelMiddlewares?: KernelModelMiddleware[];
  fileFirstConfig?: FileFirstConfig;
  agentStorage?: AgentStorage;
};

export interface AgentConfig {
  /** AI SDK model instance. */
  model: LanguageModelV3;

  /** System instruction / prompt. */
  instructions?: string;

  /** Static tools available to the agent (wired once at createAgent time). */
  tools?: ToolModel[];

  /**
   * Per-run hook that returns additional tools assembled at run time.
   * Use this when the tool set depends on runtime conditions (MCP servers,
   * model provider, session type, etc.).
   *
   * Composition order: built-ins + static `tools` + `buildRuntimeTools(ctx)` result.
   * Schedule sessions apply a recursion guard that strips mutation tools.
   */
  buildRuntimeTools?: BuildRuntimeToolsFn;

  /**
   * Per-run hook returning run-scoped config: model middlewares (compaction,
   * budget guard, caching) and tool-result offloading. Needed because these
   * depend on the run's sessionId (offload paths are session-scoped).
   * When set, its middlewares REPLACE config.modelMiddlewares for that run.
   */
  buildRunConfig?: (ctx: {
    state: StateTree;
    sessionId?: string;
    sessionType?: string;
  }) => Promise<AgentRunConfigOverrides> | AgentRunConfigOverrides;

  /** Session/state configuration. Defaults to in-memory. */
  sessions?: {
    /** State backend for persistence. Defaults to InMemoryStateBackend. */
    backend?: StateBackend;
  };

  /** Model settings (temperature, maxOutputTokens, providerOptions). */
  modelSettings?: AgentParamsT['modelSettings'];

  /** Execution limits. */
  limits?: {
    maxTurns?: number;
    maxModelCalls?: number;
    maxRetries?: number;
  };

  /** Model middlewares (e.g., caching). */
  modelMiddlewares?: KernelModelMiddleware[];

  /** Turn processors. When omitted, uses built-in defaults (system prompt, history doctor, turn input). */
  processors?: TurnProcessor[];

  /** Custom policies. Merged with defaults — only override what you need. */
  policies?: Partial<{
    stop: StopPolicy;
    retry: RetryPolicy;
    turn: TurnPolicy;
  }>;

  /** Custom runner. Defaults to ToolLoopAgentRunner. */
  runner?: AgentRunner;

  /** Custom presenter. Defaults to DefaultPresenter. */
  presenter?: KernelPresenter;

  /** Host-owned stable wording for terminal error codes. */
  resolveUserMessage?: AgentParamsT['resolveUserMessage'];

  /** Trace orchestrator for observability (e.g., Langfuse). */
  traceOrchestrator?: TraceOrchestrator;

  /** Event sink for fine-grained kernel events. */
  onEvent?: AgentKernelEventSink;

  /** Callback after each agent run completes. */
  onComplete?: (args: { state: AgentState; outcome: AgentRunOutcome }) => void | Promise<void>;

  /**
   * Custom LLM function for ctx.llm() in trigger handlers.
   * Default: uses instance.run() (has access to tools configured in AgentConfig.tools).
   * Override this on the platform to use MessagingService for full MCP tool access.
   */
  triggerLlm?: TriggerLlmFunction;

  /**
   * Callback for triggers with no registered handler.
   * Default: runs the agent with trigger payload as the query.
   * Set to null to disable LLM fallback.
   */
  onUnhandledTrigger?: UnhandledTriggerCallback | null;

  /**
   * Custom LLM function for ctx.llm() in schedule handlers.
   * Default: uses instance.run() with sessionType 'schedule'.
   * Override this on the platform to use MessagingService for full MCP tool access.
   */
  scheduleLlm?: ScheduleLlmFunction;

  /**
   * Callback for schedule events with no registered handler (__default).
   * Default: runs the agent with params.message as the query, injects delayedByHours context.
   * Set to null to disable LLM fallback.
   */
  onUnhandledSchedule?: UnhandledScheduleCallback | null;

  /** Disable built-in tools (getCurrentTime, etc.). Default: false. */
  disableBuiltInTools?: boolean;

  /** Outbound channel adapters for delivering replies. */
  channelAdapters?: OutboundChannelAdapter[];
}

/** Result from `agent.run()` — the collected response after the run completes. */
export interface AgentRunResult {
  /** The agent's text response (concatenated from all text content). */
  text: string;
  /** All content pieces produced during the run. */
  content: AgentContent[];
  /** Run outcome metadata (status, turns used, etc.). */
  outcome: AgentRunOutcome;
}

/**
 * A long-lived agent instance returned by `createAgent()`.
 * Call `run()` or `runStream()` for each user interaction.
 * Sessions are managed automatically when `sessionId` is provided.
 */
export interface AgentInstance {
  /** Run the agent and return the collected result (blocks until complete). */
  run(input: AgentRunInput): Promise<AgentRunResult>;

  /** Run the agent and return a streaming handle for real-time consumption. */
  runStream(input: AgentRunInput): Promise<AgentRunHandle>;

  /**
   * Start event processing: inbox subscription, channel handling, delivery.
   * Connects the state store, starts EventProcessor + DeliveryService,
   * and reconciles any missed inbox events.
   */
  listen(): Promise<void>;

  /** Stop event processing and clean up connections. */
  stop(): Promise<void>;

  /** Register a typed trigger handler. */
  registerTrigger(
    name: string,
    handler: TriggerHandler,
    options?: TriggerRegistrationOptions,
  ): void;

  /** Register a schedule handler for scheduled-task events. */
  registerSchedule(
    name: string,
    handler: ScheduleHandler,
    options?: ScheduleRegistrationOptions,
  ): void;

  /** Register an outbound channel adapter for delivery. */
  registerChannelAdapter(adapter: OutboundChannelAdapter): void;

  /** The session manager for this agent. */
  readonly sessionManager: SessionManager;

  /** The state tree for this agent. */
  readonly state: StateTree;

  /** The event processor (for advanced use / testing). */
  readonly eventProcessor: EventProcessor;

  /** Clean up resources (stop event processing, unsubscribe sessions). */
  dispose(): void;
}

/**
 * Create an agent with sensible defaults.
 *
 * All you need is a model — everything else is optional:
 * - State backend defaults to in-memory
 * - Session manager is created automatically
 * - Event pipeline (triggers, channels, delivery) is wired automatically
 * - Call `listen()` to start processing inbox events
 */
export function createAgent(config: AgentConfig): AgentInstance {
  const backend = config.sessions?.backend ?? new InMemoryStateBackend();
  const state = new StateTree(backend);
  const sessionManager = new SessionManager(state);

  // Built-in tools are assembled per-run so dynamic tools (via buildRuntimeTools)
  // can change between runs. Standalone users get getCurrentTime + schedule tools
  // automatically unless disableBuiltInTools is set.
  const staticBuiltInTools = config.disableBuiltInTools ? [] : getBuiltInTools(state);
  const staticUserTools = config.tools ?? [];

  // -- Agent factory (creates a fresh Agent per run) --

  async function createAgentForRun(input: AgentRunInput): Promise<Agent> {
    const runtimeTools = config.buildRuntimeTools
      ? await config.buildRuntimeTools({
          state,
          sessionId: input.sessionId,
          sessionType: input.sessionType,
        })
      : [];

    const combined = [...staticBuiltInTools, ...staticUserTools, ...runtimeTools];
    // Recursion guard: schedule sessions must not have schedule-mutation tools
    const tools = input.sessionType === 'schedule' ? filterScheduleSafeTools(combined) : combined;
    const toolRegistry = new ToolRegistry(tools);

    const runConfig: AgentRunConfigOverrides = config.buildRunConfig
      ? await config.buildRunConfig({
          state,
          sessionId: input.sessionId,
          sessionType: input.sessionType,
        })
      : {};

    return new Agent({
      systemInstruction: config.instructions ?? '',
      toolRegistry,
      model: config.model,
      modelSettings: config.modelSettings,
      limits: config.limits,
      modelMiddlewares: runConfig.modelMiddlewares ?? config.modelMiddlewares,
      fileFirstConfig: runConfig.fileFirstConfig,
      agentStorage: runConfig.agentStorage,
      processors: config.processors,
      policies: config.policies,
      runner: config.runner,
      presenter: config.presenter,
      resolveUserMessage: config.resolveUserMessage,
      traceOrchestrator: config.traceOrchestrator,
      onEvent: config.onEvent,
      onComplete: config.onComplete,
      sessionManager,
      traceName: input.sessionId ? `session:${input.sessionId}` : undefined,
    });
  }

  // -- Event pipeline --

  const triggerRouter = new TriggerRouter();
  const scheduleRouter = new ScheduleRouter();

  const channelHandler = new ChannelHandler({
    state: state,
    sessionManager,
    runAgent: async (params) => {
      const agent = await createAgentForRun(params);
      // Inject channel context so the agent knows who it's talking to.
      // Sanitize user-controlled fields to prevent prompt injection via newlines/brackets.
      const cm = params.channelMessage;
      const sanitize = (s: string) => s.replace(/[\n\r[\]]/g, '').slice(0, 100);
      const senderLabel = sanitize(cm.sender.name || cm.sender.id);
      const channelLabel = sanitize(
        cm.threadId
          ? `${cm.channelType}/${cm.channelId}/${cm.threadId}`
          : `${cm.channelType}/${cm.channelId}`,
      );
      const contextLine = `\n\n[Channel: ${channelLabel} | From: ${senderLabel}]`;
      return agent.runHandle({
        query: params.query,
        sessionId: params.sessionId,
        sessionType: params.sessionType,
        sessionName: params.sessionName,
        channelContext: contextLine,
      });
    },
  });

  const deliveryService = new DeliveryService({
    state: state,
    adapters: config.channelAdapters,
  });

  // Defer dispatcher creation — onUnhandled callbacks reference the instance
  let triggerDispatcher: TriggerDispatcher;
  let scheduleDispatcher: ScheduleDispatcher;
  let eventProcessor: EventProcessor;

  function ensureEventProcessor(): EventProcessor {
    if (!triggerDispatcher) {
      const onUnhandled: UnhandledTriggerCallback | undefined =
        config.onUnhandledTrigger === null
          ? undefined
          : (config.onUnhandledTrigger ?? defaultUnhandledTrigger);

      triggerDispatcher = new TriggerDispatcher({
        router: triggerRouter,
        state: state,
        llm: config.triggerLlm ?? defaultTriggerLlm,
        onUnhandled,
      });

      const onUnhandledSchedule: UnhandledScheduleCallback | undefined =
        config.onUnhandledSchedule === null
          ? undefined
          : (config.onUnhandledSchedule ?? defaultUnhandledSchedule);

      scheduleDispatcher = new ScheduleDispatcher({
        router: scheduleRouter,
        state: state,
        llm: config.scheduleLlm ?? defaultScheduleLlm,
        onUnhandled: onUnhandledSchedule,
      });

      eventProcessor = new EventProcessor({
        state: state,
        triggerDispatcher,
        scheduleDispatcher,
        channelHandler,
        sessionManager,
      });
    }
    return eventProcessor;
  }

  // ctx.llm() implementation — uses custom override or falls back to instance.run()
  const defaultTriggerLlm: TriggerLlmFunction = async (options, event, sessionId) => {
    const sid = sessionId ?? `trigger-${event.triggerId || event.eventId}-${Date.now()}`;
    const triggerLabel = event.triggerName.replace(/_/g, ' ');
    const sessionName = `${event.provider}: ${triggerLabel}`;

    const result = await instance.run({
      query: options.message,
      sessionId: sid,
      sessionType: 'trigger',
      sessionName,
    });
    return { text: result.text };
  };

  // -- Schedule LLM defaults --

  // ctx.llm() implementation for schedule handlers
  const defaultScheduleLlm: ScheduleLlmFunction = async (options, event, sessionId) => {
    const sid = sessionId ?? `cron-${event.taskId}-run-${event.eventId}`;
    const result = await instance.run({
      query: options.message,
      sessionId: sid,
      sessionType: 'schedule',
      sessionName: `Schedule: ${event.taskId}`,
    });
    return { text: result.text };
  };

  // Default LLM fallback for unhandled schedule events (__default handler)
  const defaultUnhandledSchedule: UnhandledScheduleCallback = (event, sessionId) => {
    let message = (event.params.message as string) || `Scheduled task: ${event.taskId}`;
    if (event.delayedByHours) {
      message += `\n(Note: this task was scheduled for ${event.scheduledAt} but is being delivered ~${event.delayedByHours.toFixed(1)}h late due to a system delay.)`;
    }
    const sid = sessionId ?? `cron-${event.taskId}-run-${event.eventId}`;
    // Fire-and-forget
    instance
      .run({
        query: message,
        sessionId: sid,
        sessionType: 'schedule',
        sessionName: `Schedule: ${event.taskId}`,
      })
      .catch((err) => {
        console.error('[createAgent] Default schedule LLM fallback failed:', err);
      });
  };

  // Default LLM fallback for unhandled triggers: run the agent with trigger payload as query
  const defaultUnhandledTrigger: UnhandledTriggerCallback = (event, sessionId) => {
    const triggerInfo: Record<string, unknown> = {
      trigger_name: event.triggerName,
      provider: event.provider,
      timestamp: event.timestamp,
      data: event.payload,
    };
    const query = `[composio-trigger]\n${JSON.stringify(triggerInfo, null, 2)}`;
    const sid = sessionId ?? `trigger-${event.triggerId || event.eventId}-${Date.now()}`;
    const triggerLabel = event.triggerName.replace(/_/g, ' ');
    const sessionName = `${event.provider}: ${triggerLabel}`;

    // Fire-and-forget
    instance.run({ query, sessionId: sid, sessionType: 'trigger', sessionName }).catch((err) => {
      console.error('[createAgent] Default trigger LLM fallback failed:', err);
    });
  };

  let listening = false;
  /** Per-session promise chain — serializes runs so concurrent calls queue instead of corrupting. */
  const sessionLocks = new Map<string, Promise<unknown>>();

  const instance: AgentInstance = {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const handle = await this.runStream(input);

      const content: AgentContent[] = [];
      for await (const chunk of handle.stream) {
        content.push(chunk);
      }

      const outcome = await handle.done;

      const text = content
        .filter((c) => c.type === ContentType.Text)
        .map((c) => (c as { content?: string }).content ?? '')
        .join('');

      return { text, content, outcome };
    },

    async runStream(input: AgentRunInput): Promise<AgentRunHandle> {
      // No session — no concurrency risk, run directly
      if (!input.sessionId) {
        const agent = await createAgentForRun(input);
        return agent.runHandle(input);
      }

      const sid = input.sessionId;
      const prev = sessionLocks.get(sid) ?? Promise.resolve();

      // Deferred: resolves when the handle is ready (before the run completes)
      let resolveHandle!: (h: AgentRunHandle) => void;
      let rejectHandle!: (err: unknown) => void;
      const handleReady = new Promise<AgentRunHandle>((resolve, reject) => {
        resolveHandle = resolve;
        rejectHandle = reject;
      });

      // Chain: wait for previous run → start this run → signal handle → hold until done
      const chain = prev
        .catch(() => {})
        .then(async () => {
          try {
            const agent = await createAgentForRun(input);
            const handle = await agent.runHandle(input);
            resolveHandle(handle);
            await handle.done.catch(() => {});
          } catch (err) {
            rejectHandle(err);
          }
        });
      sessionLocks.set(sid, chain);
      chain.finally(() => {
        if (sessionLocks.get(sid) === chain) {
          sessionLocks.delete(sid);
        }
      });

      return handleReady;
    },

    async listen(): Promise<void> {
      if (listening) {
        return;
      }
      listening = true;

      console.log('[Agent] Starting event processing...');

      await state.connect();

      const processor = ensureEventProcessor();
      processor.start();
      deliveryService.start();

      // Reconcile missed inbox events
      const reconciler = new InboxReconciler({
        state: state,
        processor,
      });
      await reconciler.reconcile();

      console.log('[Agent] Event processing started');
    },

    async stop(): Promise<void> {
      if (!listening) {
        return;
      }
      listening = false;

      console.log('[Agent] Stopping event processing...');
      await ensureEventProcessor().stop();
      await deliveryService.stop();
      state.disconnect();
    },

    registerTrigger(
      name: string,
      handler: TriggerHandler,
      options?: TriggerRegistrationOptions,
    ): void {
      triggerRouter.register(name, handler, options);
    },

    registerSchedule(
      name: string,
      handler: ScheduleHandler,
      options?: ScheduleRegistrationOptions,
    ): void {
      scheduleRouter.register(name, handler, options);
    },

    registerChannelAdapter(adapter: OutboundChannelAdapter): void {
      deliveryService.registerAdapter(adapter);
    },

    get sessionManager() {
      return sessionManager;
    },

    get state() {
      return state;
    },

    get eventProcessor() {
      return ensureEventProcessor();
    },

    dispose() {
      if (listening) {
        this.stop().catch((err) => {
          console.error('[Agent] dispose stop failed:', err);
        });
      }
      sessionManager.dispose();
    },
  };

  return instance;
}
