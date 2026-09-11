import {
  ContentType,
  createTextContent,
  type AgentContent,
  type ComponentContent,
} from '../types/content.ts';
import {
  AgentBudgetError,
  EmptyModelResponseError,
  FirstTokenTimeoutError,
  LlmErrorCode,
} from '../types/errors.ts';
import { getAgentLogger } from '../types/logger.ts';
import { logAgentError } from '../util/log-agent-error.ts';
import { generateShortId } from '../types/id.ts';
import { CancelableStream } from '../types/cancelable-stream.ts';
import { ContentStream } from '../types/content-stream.ts';
import { EventStream } from '../types/event-stream.ts';
import { AguiEventStream } from '../agui/agui-event-stream.ts';
import { AGUI_CUSTOM_EVENT_NAMES, aguiEvent } from '../agui/events.ts';
import { AgentMode } from '../types/mode.ts';

import AgentState, { readMessageId } from './agent-state.ts';
import { applyResumeToolResults, type ResumeOutcome, type ResumeToolResult } from './blocking.ts';
import { diffInjectedMessages } from './history-diff.ts';
import type { AgentMessagesListener } from '../sessions/produced-messages.ts';
import { ToolRegistry, type IToolRegistry } from '../tools/tool-registry.ts';
import { AgentService, type AgentRunOutcome } from './agent.service.ts';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { AgentRunner } from '../runners/agent-runner.ts';
import type { ModelMessage, ProviderOptions } from '@ai-sdk/provider-utils';
import {
  type KernelModelMiddleware,
  wrapModelWithKernelMiddlewares,
} from '../kernel/middlewares/index.ts';
import type { AgentKernelEventSink } from '../kernel/events.ts';
import type { AgentRunHandle } from '../kernel/run-handle.ts';
import type { RetryPolicy, StopPolicy, TurnPolicy } from '../kernel/policies.ts';
import type { KernelPresenter } from '../kernel/presenter.ts';
import type { ZodType } from 'zod';
import type { Attachment, PrepareStepCallback, TerminalErrorResolver } from './interfaces.ts';
import type { SessionManager } from '../sessions/session-manager.ts';
import { toAgentContent } from '../sessions/session-manager.ts';
import { buildContentItems } from '../sessions/content-builder.ts';
import type { ConversationMessage, SessionType } from '../sessions/types.ts';
import { createCheckpointMessage } from '../sessions/checkpoint.ts';
import { FinalPromptCaptureMiddleware } from '../defaults/middlewares/final-prompt-capture.middleware.ts';
import { TurnInputProcessor } from '../defaults/processors/turn-input.processor.ts';
import type { TurnProcessor } from '../kernel/processors/types.ts';
import { SystemPromptProcessor } from '../defaults/processors/system-prompt.processor.ts';
import { HistoryDoctorProcessor } from '../defaults/processors/history-doctor.processor.ts';
import { applyProcessors } from './apply-processors.ts';
import { policies as defaultPolicies } from '../defaults/policies.ts';
import { DefaultPresenter } from '../defaults/presenter.ts';
import { ToolLoopAgentRunner } from '../runners/tool-loop-agent.runner.ts';
import type { TraceOrchestrator } from '../telemetry/trace-orchestrator.ts';
import { getToolResults, getToolResultString } from '../kernel/utils/message-parts.ts';
import { extractCompactionSummary } from '../defaults/middlewares/compaction-summarizer.ts';

export type AgentParamsT = {
  /** Agent execution mode */
  agentMode?: AgentMode;
  /** Initial agent state. If not provided, a new state will be created. */
  state?: AgentState;
  /** Trace name for observability. Sets `state.traceConfig.name`. */
  traceName?: string;
  /** System instruction/prompt template. Omit when using a custom system prompt processor. */
  systemInstruction?: string;
  /** Tool registry. If not provided, an empty registry will be used. */
  toolRegistry?: IToolRegistry;
  /** Language model to use */
  model?: LanguageModelV3;
  /** Execution limits */
  limits?: {
    maxTurns?: number;
    maxModelCalls?: number;
    maxRetries?: number;
    maxContinuations?: number;
  };
  /** Model configuration */
  modelSettings?: {
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
  };
  /** Model middlewares for prompt transformation */
  modelMiddlewares?: KernelModelMiddleware[];
  /** Turn processors */
  processors?: TurnProcessor[];
  /** Agent runner. Defaults to AgentRunner. */
  runner?: AgentRunner;
  /** Policies for controlling agent behavior. Defaults to built-in policies. */
  policies?: {
    stop?: StopPolicy;
    retry?: RetryPolicy;
    turn?: TurnPolicy;
  };
  /** Host-owned stable wording for terminal error codes. */
  resolveUserMessage?: (code: LlmErrorCode, state: AgentState) => string | undefined;
  /** Event sink for observability */
  onEvent?: AgentKernelEventSink;
  /** External trace orchestrator (e.g., Langfuse SDK) */
  traceOrchestrator?: TraceOrchestrator;
  /** Callback when agent completes */
  onComplete?: (args: { state: AgentState; outcome: AgentRunOutcome }) => void | Promise<void>;
  /** UI presenter. Defaults to DefaultPresenter. */
  presenter?: KernelPresenter;
  /** Session manager for automatic conversation persistence. */
  sessionManager?: SessionManager;
  /** Per-step hook — called before each model call in the tool loop. Can modify messages. */
  prepareStep?: PrepareStepCallback;
  /** User-supplied stop condition(s). Merged with the default `stepCountIs(maxSteps)` and any `stopAtToolNames` predicates. */
  stopWhen?:
    | import('ai').StopCondition<import('ai').ToolSet>
    | Array<import('ai').StopCondition<import('ai').ToolSet>>;
  /**
   * Timeout in milliseconds for receiving the first token from the model.
   * If the model does not produce any output within this time, the call is aborted and retried.
   */
  firstTokenTimeoutMs?: number;
  /** File-first offloading config. When set, large tool results are written to disk. */
  fileFirstConfig?: import('./file-first-offloader.ts').FileFirstConfig;
  /** AgentStorage for file-first offloading and unified data access */
  agentStorage?: import('../storage/agent-storage.ts').AgentStorage;
  /**
   * Optional host hook to render a terminal (non-retryable) error as a UI
   * component instead of the default text message. See `CreateAgentParams`.
   */
  resolveTerminalErrorComponent?: TerminalErrorResolver;
};

/**
 * Input for agent.run() and agent.runHandle()
 */
export type AgentRunInput = {
  /** User query/instruction */
  query: string;
  /** File attachments */
  attachments?: Attachment[];
  /**
   * Session ID for automatic conversation persistence.
   * When provided (and sessionManager is set on the agent), the library:
   * 1. Loads conversation history from the session before running
   * 2. Saves updated history after the run completes
   * 3. Manages session status (idle → processing → idle/error)
   * When omitted, behavior is unchanged (caller manages history).
   */
  sessionId?: string;
  /** Session type for categorization. Defaults to 'web'. */
  sessionType?: import('../sessions/types.ts').SessionType;
  /** Human-readable session name. Set at creation for inbox types (channel/trigger/webhook/schedule). */
  sessionName?: string;
  /** Channel context string (e.g., "[Channel: slack/general | From: John]"). Appended to system prompt for channel sessions. */
  channelContext?: string;
  /**
   * Pre-fetched conversation messages. When provided (and sessionId + sessionManager
   * are set), the library uses these directly instead of calling loadConversation().
   * Server-side callers that pre-fetch history in parallel with other setup work
   * (e.g. BuilderSessionLoader) use this to eliminate the per-turn DDB round-trip.
   * Deployed agents that call runHandle() without pre-fetching omit this field.
   */
  messages?: ConversationMessage[];
  /**
   * Answers to tool calls paused on a prior turn (blocking / human-in-the-loop).
   * The SDK rewrites the matching placeholder tool-results in loaded history
   * before resuming. Omit on normal turns.
   */
  resumeToolResults?: ResumeToolResult[];
};

const logger = getAgentLogger();

export default class Agent implements Agent {
  private readonly state: AgentState;
  private readonly systemInstruction: string;
  private readonly toolRegistry: IToolRegistry;
  private readonly model: LanguageModelV3 | undefined;
  private maxAgentTurns: number;
  private maxModelCallsCount: number;
  private maxRetries: number;
  private maxContinuations: number;
  private modelSettings:
    | { temperature?: number; maxOutputTokens?: number; providerOptions?: ProviderOptions }
    | undefined;
  private agentMode: AgentMode;
  private isDone: boolean = false;
  private modelMiddlewares: KernelModelMiddleware[];
  private runner: AgentRunner;
  private policies: {
    stop: StopPolicy;
    retry: RetryPolicy;
    turn: TurnPolicy;
  };
  private onEvent?: AgentKernelEventSink;
  private traceOrchestrator?: TraceOrchestrator;
  private onComplete?: AgentParamsT['onComplete'];
  private presenter: KernelPresenter;
  private runDone: ((outcome: AgentRunOutcome) => void) | null = null;
  private runDonePromise: Promise<AgentRunOutcome> | null = null;
  private nextRetryDelayMs: number = 1000;
  private outputSchema: ZodType<unknown> | undefined;
  private processors: TurnProcessor[];
  private resolveUserMessage: NonNullable<AgentParamsT['resolveUserMessage']> | undefined;

  private currentContentStream: ContentStream | undefined;
  private currentEventStream: EventStream | undefined;
  private currentAguiStream: AguiEventStream | undefined;
  private lastRun: AgentRunOutcome | null = null;
  /** Abort controller for the currently running turn (model + tools). */
  private currentAbortController: AbortController | null = null;
  private sessionManager?: SessionManager;
  private prepareStep?: PrepareStepCallback;
  private stopWhen?: AgentParamsT['stopWhen'];
  private firstTokenTimeoutMs?: number;
  /** Session ID for the current run (set in runHandle, used in stopProcessing). */
  private activeSessionId?: string;
  /** Session type for the current run (set in runHandle; threads into AgentService's headless blocking policy). */
  private activeSessionType?: SessionType;
  #activeRunResponseId?: string;
  /** The turn's AgentService (set per turn in callAgent, read in stopProcessing). */
  #activeAgentService?: AgentService;
  /** Settles after the active runner has committed its final step messages into AgentState. */
  #activeAgentRun?: Promise<AgentRunOutcome>;
  /** Channel context appended to system instruction for channel sessions. */
  private channelContext?: string;
  /** File-first offloading config for large tool results. */
  private fileFirstConfig?: import('./file-first-offloader.ts').FileFirstConfig;
  #agentStorage?: import('../storage/agent-storage.ts').AgentStorage;
  #resolveTerminalErrorComponent?: TerminalErrorResolver;

  constructor(params: AgentParamsT) {
    // Create default state if not provided
    this.state =
      params.state ??
      AgentState.createTurn({
        kernel: {
          conversationHistory: [],
          trace: params.traceName ? { name: params.traceName } : undefined,
        },
      });

    // If state was provided but traceName is also provided, update trace config
    if (params.state && params.traceName) {
      this.state.setTraceConfig({ name: params.traceName });
    }

    this.systemInstruction = params.systemInstruction ?? '';
    this.toolRegistry = params.toolRegistry ?? new ToolRegistry([]);
    this.model = params.model;
    this.agentMode = params.agentMode ?? AgentMode.Agent;
    this.maxAgentTurns = params.limits?.maxTurns ?? 5;
    this.maxModelCallsCount = params.limits?.maxModelCalls ?? 200;
    this.maxRetries = params.limits?.maxRetries ?? 3;
    this.maxContinuations = params.limits?.maxContinuations ?? 5;
    this.modelSettings = params.modelSettings;
    this.modelMiddlewares = params.modelMiddlewares ?? [];
    this.processors = params.processors ?? [
      new SystemPromptProcessor(() => this.getSystemInstruction()),
      new TurnInputProcessor(),
      new HistoryDoctorProcessor(params.model?.provider),
    ];

    // Default runner: ToolLoopAgentRunner
    this.runner = params.runner ?? new ToolLoopAgentRunner();

    // Default policies: merge with provided
    this.policies = {
      stop: params.policies?.stop ?? defaultPolicies.stop,
      retry: params.policies?.retry ?? defaultPolicies.retry,
      turn: params.policies?.turn ?? defaultPolicies.turn,
    };

    this.onEvent = params.onEvent;
    this.traceOrchestrator = params.traceOrchestrator;
    this.onComplete = params.onComplete;
    this.resolveUserMessage = params.resolveUserMessage;

    // Default presenter
    this.presenter = params.presenter ?? new DefaultPresenter();

    // Session manager for automatic persistence
    this.sessionManager = params.sessionManager;

    this.prepareStep = params.prepareStep;
    this.stopWhen = params.stopWhen;
    this.firstTokenTimeoutMs = params.firstTokenTimeoutMs;
    this.fileFirstConfig = params.fileFirstConfig;
    this.#agentStorage = params.agentStorage;
    this.#resolveTerminalErrorComponent = params.resolveTerminalErrorComponent;
  }

  getState(): AgentState {
    return this.state;
  }

  /** Subscribe to the neutral message-lifecycle event (injected + per-step deltas). */
  onMessages(cb: AgentMessagesListener): void {
    this.state.onMessages(cb);
  }

  async runHandle(input: AgentRunInput): Promise<AgentRunHandle>;
  async runHandle<TResult>(
    input: AgentRunInput,
    options: { outputSchema: ZodType<TResult> },
  ): Promise<AgentRunHandle<TResult>>;
  async runHandle<TResult>(
    input: AgentRunInput,
    options?: { outputSchema?: ZodType<TResult> },
  ): Promise<AgentRunHandle<TResult>> {
    if (this.runDonePromise) {
      throw new Error('Agent.runHandle() can only be called once per Agent instance');
    }

    this.activeSessionType = input.sessionType ?? 'web';

    if (input.sessionId && this.sessionManager) {
      this.activeSessionId = input.sessionId;
      await this.sessionManager.getOrCreate(
        input.sessionId,
        input.sessionType ?? 'web',
        input.sessionName,
      );

      const recordingSm = this.sessionManager;
      const recordingSessionId = input.sessionId;
      this.onMessages((event) => recordingSm.recordMessages(recordingSessionId, event));
      this.state.onContent((event) => recordingSm.recordContent(recordingSessionId, event));

      // Intentionally not awaited — status marker for crash recovery; must not block handle return.
      void this.sessionManager
        .updateStatus(input.sessionId, 'processing')
        .catch((err) => logger.warn('[Agent] updateStatus(processing) failed', { error: err }));

      const runResponseId = this.state.getResponseId();
      this.#activeRunResponseId = runResponseId;
      await this.sessionManager
        .setCurrentRun(input.sessionId, { responseId: runResponseId, startedAt: Date.now() })
        .catch((err) => logger.warn('[Agent] setCurrentRun(processing) failed', { error: err }));

      try {
        const messages =
          input.messages ?? (await this.sessionManager.loadConversation(input.sessionId));
        if (messages.length > 0) {
          const modelMessages = messages.map((m) => m.data) as ModelMessage[];
          // Persisted history keeps blocking-tool placeholders as written
          // (append-only storage) — replay previously recorded click answers,
          // then apply this turn's responses (later entries win on collision).
          const compactionRecord = await this.sessionManager
            .loadLatestCompactionRecord(input.sessionId)
            .catch(() => null);
          this.state.setLoadedCompactionSummary(compactionRecord?.summary ?? null);

          const stored = await this.sessionManager.loadResolvedToolResults(input.sessionId);
          const resume = applyResumeToolResults(
            modelMessages,
            input.resumeToolResults ?? [],
            stored,
          );
          this.state.setConversationHistory(resume.history);
          if (resume.hadPending) {
            this.state.clearPendingToolCalls();
            this.sessionManager.recordResolvedToolResults(input.sessionId, resume.resolutions);
          }
          this.#warnOnUnappliedAnswers(input.sessionId, input.resumeToolResults, resume);
          logger.info('[Agent] Loaded session history', {
            sessionId: input.sessionId,
            messageCount: messages.length,
          });
        }
      } catch (err) {
        // Reset status so the session isn't stuck in 'processing' forever
        await this.sessionManager.updateStatus(input.sessionId, 'error').catch(() => {});
        await this.sessionManager
          .finalizeCurrentRun(input.sessionId, runResponseId, 'error')
          .catch(() => {});
        this.activeSessionId = undefined;
        this.#activeRunResponseId = undefined;
        throw err;
      }
    }

    const contentStream = new ContentStream();
    const eventStream = new EventStream();
    const aguiStream = new AguiEventStream();
    const cancelableStream = new CancelableStream(async () => contentStream);
    this.outputSchema = options?.outputSchema as ZodType<unknown> | undefined;

    this.currentEventStream = eventStream;
    this.currentAguiStream = aguiStream;

    if (input.channelContext) {
      this.channelContext = input.channelContext;
    }

    this.state.setUserQueryText(input.query);
    this.state.setAttachments(input.attachments);

    this.runDonePromise = new Promise<AgentRunOutcome>((resolve) => {
      this.runDone = resolve;
    });

    this.onEvent?.({ type: 'run-start', agentMode: this.agentMode });

    cancelableStream.on('abort', () => {
      this.currentAbortController?.abort();
      this.stopProcessing(contentStream);
    });
    this.callAgent(contentStream).catch((error) => {
      logAgentError('[Agent] Unhandled error in callAgent:', error);
    });

    const result = options?.outputSchema
      ? this.runDonePromise.then((outcome) => {
          if (outcome.status !== 'ok') {
            throw new Error(`Run did not complete successfully (${outcome.status})`);
          }
          return options.outputSchema!.parse(outcome.structuredOutput);
        })
      : undefined;

    return {
      stream: cancelableStream,
      events: eventStream,
      agui: aguiStream,
      done: this.runDonePromise,
      result,
    };
  }

  /**
   * Run the agent with the given input and return a stream of content.
   *
   * @example
   * ```typescript
   * const stream = await agent.run({ query: 'What is the weather in Tokyo?' });
   * for await (const content of stream) {
   *   console.log(content);
   * }
   * ```
   */
  async run(input: AgentRunInput): Promise<CancelableStream<AgentContent>> {
    const handle = await this.runHandle(input);
    return handle.stream;
  }

  private getSystemInstruction() {
    if (this.channelContext) {
      return this.systemInstruction + this.channelContext;
    }
    return this.systemInstruction;
  }

  private getStopAtToolNamesByAgentMode(agentMode: AgentMode): string[] | undefined {
    const configured = this.policies.stop({
      agentMode,
      toolRegistry: this.toolRegistry,
    }).stopAtToolNames;
    return configured && configured.length > 0 ? configured : undefined;
  }

  async callAgent(resultingStream: ContentStream) {
    let turnIndex = 0;
    while (!this.isDone) {
      try {
        this.onEvent?.({ type: 'turn-start', turnIndex });
        if (this.state.getModelCallsCount() >= this.maxAgentTurns) {
          logger.info('[Agent] Stopping agent because max agent turns exceeded');
          this.stopProcessing(resultingStream);
          return;
        }

        if (this.state.getRetriesCount() > this.maxRetries) {
          logger.info('[Agent] Stopping agent: retry budget exhausted (backstop)');
          this.stopProcessing(
            resultingStream,
            this.resolveUserMessage?.(LlmErrorCode.retryExhausted, this.state),
            LlmErrorCode.retryExhausted,
          );
          return;
        }

        const loadedHistory = [...this.state.getConversationHistory()];

        const messages = await applyProcessors({
          state: this.state,
          processors: this.processors,
        });

        if (turnIndex === 0 && this.activeSessionId) {
          const injected = diffInjectedMessages(loadedHistory, this.state.getConversationHistory());
          this.state.emitMessages(injected);

          const responseId = this.state.getResponseId();
          const userContent = injected
            .filter((m) => m.role === 'user')
            .flatMap((m) => buildContentItems(m as Record<string, unknown>, responseId))
            .map((item) => toAgentContent(item))
            .filter((c): c is AgentContent => c !== null);
          this.state.emitContent(userContent);
        }

        // A stop during applyProcessors lands before currentAbortController
        // exists, so stopProcessing had nothing to abort — without this check
        // the turn would install a fresh controller and run as a zombie.
        if (this.isDone) {
          return;
        }

        this.populateStateWithModelInfo();

        if (!this.model) {
          throw new Error('Model is required to run the agent');
        }

        const modelToUse: LanguageModelV3 = wrapModelWithKernelMiddlewares({
          model: this.model,
          ctx: { state: this.state },
          middlewares: [...this.modelMiddlewares, new FinalPromptCaptureMiddleware()],
        });

        const abortController = new AbortController();
        this.currentAbortController = abortController;

        const agentService = new AgentService({
          state: this.state,
          toolRegistry: this.toolRegistry,
          runner: this.runner,
          traceOrchestrator: this.traceOrchestrator,
          abortController,
          sessionId: this.activeSessionId,
          fileFirstConfig: this.fileFirstConfig,
          agentStorage: this.#agentStorage,
        });
        this.#activeAgentService = agentService;

        this.state.setError(null);

        this.currentContentStream = new ContentStream();

        const runPromise = agentService.stream({
          ui: this.currentContentStream,
          eventSink: this.currentEventStream,
          aguiSink: (ev) => this.currentAguiStream?.append(ev),
          sessionType: this.activeSessionType,
          instructions: '',
          model: modelToUse,
          messages,
          modelSettings: this.modelSettings,
          maxSteps: this.maxModelCallsCount,
          stopAtToolNames: this.getStopAtToolNamesByAgentMode(this.agentMode),
          structuredOutputSchema: this.outputSchema,
          prepareStep: this.prepareStep,
          stopWhen: this.stopWhen,
        });
        this.#activeAgentRun = runPromise;

        // First-token timeout: abort the model call if no content arrives within the limit.
        let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
        let firstTokenTimedOut = false;
        if (this.firstTokenTimeoutMs && !abortController.signal.aborted) {
          firstTokenTimer = setTimeout(() => {
            firstTokenTimedOut = true;
            logger.warn('[Agent] First token timeout — aborting model call', {
              timeoutMs: this.firstTokenTimeoutMs,
            });
            abortController.abort();
          }, this.firstTokenTimeoutMs);
        }

        for await (const content of this.currentContentStream) {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }

          if (content) {
            content.responseId = this.state.getResponseId();
            if (!content.messageId) {
              (content as AgentContent).messageId = generateShortId(8);
            }
            resultingStream.append(content);
          }
        }

        if (firstTokenTimer) {
          clearTimeout(firstTokenTimer);
          firstTokenTimer = null;
        }

        // If the stream ended because of first-token timeout, throw to trigger retry
        if (firstTokenTimedOut) {
          throw new FirstTokenTimeoutError(this.firstTokenTimeoutMs!);
        }

        this.lastRun = await runPromise;
        logger.info('[Agent] Step completed', {
          turnIndex,
          status: this.lastRun?.status,
          finishReason: this.lastRun?.status === 'ok' ? this.lastRun.finishReason : undefined,
          stopReason: this.lastRun?.status === 'ok' ? this.lastRun.stopReason : undefined,
        });
        this.onEvent?.({
          type: 'turn-end',
          turnIndex,
          outcome: this.lastRun,
          traceId: this.state.getTraceId?.(),
        });

        if (this.lastRun.status === 'error') {
          this.handleError(this.lastRun.error, resultingStream);
        }

        if (this.lastRun.status === 'ok' && this.lastRun.stopReason === 'max-steps') {
          this.#mirrorTerminalContentToAgui(
            this.presenter.emitExecutionLimit({
              sink: resultingStream,
              state: this.state,
              maxExecutions: this.maxModelCallsCount,
            }),
          );
          this.stopProcessing(resultingStream);
          return;
        }

        if (this.lastRun.status === 'ok' && this.lastRun.finishReason === 'content-filter') {
          logger.warn('[Agent] Stopping: content filter triggered');
          this.#mirrorTerminalContentToAgui(
            this.presenter.emitTerminalMessage({
              sink: resultingStream,
              state: this.state,
              message:
                '\n\nMy response was blocked by a content filter. Please rephrase your request.',
            }),
          );
          this.stopProcessing(resultingStream);
          return;
        }

        if (this.lastRun.status === 'ok' && this.lastRun.finishReason === 'length') {
          const continuations = this.state.getContinuationCount();
          if (continuations >= this.maxContinuations) {
            logger.info('[Agent] Stopping: max continuations reached', { continuations });
            this.#mirrorTerminalContentToAgui(
              this.presenter.emitTerminalMessage({
                sink: resultingStream,
                state: this.state,
                message: '\n\nI reached the output limit and could not continue further.',
              }),
            );
            this.stopProcessing(resultingStream);
            return;
          }
          logger.info('[Agent] Auto-continuing after output token limit', {
            continuationCount: continuations + 1,
          });
          this.state.increaseContinuationCount();
          turnIndex += 1;
          continue;
        }

        // Thrown rather than routed through setError: only `handleError`
        // consults the retry policy and counts retries.
        // A provider can drop the answer and still label it a normal completion, so a
        // reported zero output is what separates a failure from a finished turn.
        if (
          this.lastRun.status === 'ok' &&
          this.lastRun.finalStepEmpty &&
          (this.lastRun.finishReason === 'other' || this.lastRun.finalStepReportedZeroOutput)
        ) {
          throw new EmptyModelResponseError();
        }

        if (
          this.lastRun.status === 'ok' &&
          this.agentMode !== AgentMode.Agent &&
          this.lastRun.stoppedByToolName
        ) {
          logger.info(
            `[Agent] Stopping because tool "${this.lastRun.stoppedByToolName}" was invoked in mode "${this.agentMode}"`,
          );
          this.stopProcessing(resultingStream);
          return;
        }

        logger.info('[Agent] Stream ended');
        this.state.increaseModelCallsCount();
        turnIndex += 1;
        this.state.resetContinuationCount();

        // Reset escalation after a successful turn (no error).
        // Truncation already persisted to state, so the next turn starts
        // from a compacted baseline without being unnecessarily aggressive.
        if (this.state.getTruncationEscalationLevel() > 0 && !this.state.getError()) {
          this.state.resetTruncationEscalationLevel();
        }

        if (this.state.getError()) {
          const delayMs = this.nextRetryDelayMs;
          this.nextRetryDelayMs = 1000;
          this.onEvent?.({ type: 'retry-scheduled', delayMs });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.info('[Agent] Invoking turn policy');
        const decision = await this.policies.turn({
          phase: 'turn-end',
          agentMode: this.agentMode,
          state: this.state,
          outcome: this.lastRun ?? { status: 'aborted', history: [] },
          sink: resultingStream,
          presenter: this.presenter,
        });
        if (decision.shouldStop) {
          logger.info('[Agent] Turn policy: stop');
          this.stopProcessing(resultingStream);
        } else {
          logger.info('[Agent] Turn policy: continue');
        }
      } catch (error) {
        this.handleError(error, resultingStream);
        if (this.nextRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.nextRetryDelayMs));
          this.nextRetryDelayMs = 1000;
        }
      } finally {
        this.currentContentStream = undefined;
        this.lastRun = null;
        this.currentAbortController = null;
      }
    }
  }

  private populateStateWithModelInfo() {
    if (!this.state.getModelId?.() && this.model?.modelId) {
      this.state.setModelId?.(this.model.modelId);
      this.state.setProvider?.(this.model.provider);
    }
  }

  private processRetryableError(error: unknown) {
    // Silent during retries — the run's progress indicator already signals work;
    // only exhaustion emits a message.
    this.state.increaseRetriesCount();
    this.state.setError(error instanceof Error ? error : new Error('Retryable error'));
  }

  private handleError(error: unknown, resultingStream: ContentStream) {
    this.onEvent?.({ type: 'error', error });

    if (error instanceof AgentBudgetError) {
      logger.warn(`[Agent] handleError: ${error.message}`);
      this.stopProcessing(
        resultingStream,
        this.resolveUserMessage?.(LlmErrorCode.budgetExhausted, this.state),
        LlmErrorCode.budgetExhausted,
      );
      return;
    }

    // Host-mapped terminal errors (e.g. billing/credit exhaustion) render as a
    // UI component and stop the run — consulted before the retry policy so they
    // are never retried or shown as a generic error message.
    const terminalComponent = this.#resolveTerminalErrorComponent?.(error);
    if (terminalComponent) {
      logger.warn('[Agent] handleError: terminal error rendered as component', {
        componentName: terminalComponent.componentName,
      });
      this.state.setError(error instanceof Error ? error : new Error(String(error)));
      this.presenter.emitComponent({
        sink: resultingStream,
        state: this.state,
        componentName: terminalComponent.componentName,
        props: terminalComponent.props,
      });
      this.stopProcessing(resultingStream);
      return;
    }

    logAgentError('[Agent] handleError', error);

    const decision = this.policies.retry({
      error,
      state: this.state,
      retries: this.state.getRetriesCount(),
      maxRetries: this.maxRetries,
    });

    this.nextRetryDelayMs = decision.delayMs;

    if (decision.triggerTruncation) {
      const newLevel = this.state.increaseTruncationEscalationLevel();
      logger.info('[Agent] Escalated truncation level due to "too long" error', {
        truncationEscalationLevel: newLevel,
      });
    }

    if (!decision.shouldRetry) {
      this.state.setError(error instanceof Error ? error : new Error(String(error)));
      const errorCode = decision.errorCode ?? LlmErrorCode.unknown;
      this.stopProcessing(
        resultingStream,
        decision.userMessage ?? this.resolveUserMessage?.(errorCode, this.state),
        errorCode,
      );
      return;
    }

    if (decision.triggerTruncation) {
      this.state.increaseRetriesCount();
      this.state.setError(error instanceof Error ? error : new Error('Prompt too long'));
      return;
    }

    this.processRetryableError(error);
  }

  /** Terminal presenter emissions ride the native AG-UI stream too — live
   *  clients consume only AG-UI frames, so a legacy-only terminal message is
   *  invisible until a session replay. */
  #mirrorTerminalContentToAgui(content: AgentContent): void {
    if (this.currentAguiStream && !this.currentAguiStream.isEnded()) {
      this.currentAguiStream.append(aguiEvent.custom(AGUI_CUSTOM_EVENT_NAMES.content, { content }));
    }
  }

  private stopProcessing(
    resultingStream: ContentStream,
    message?: string,
    errorCode?: LlmErrorCode,
  ) {
    logger.info(`[Agent] stopProcessing called`);
    if (this.isDone) {
      return;
    }

    this.isDone = true;

    this.currentAbortController?.abort();

    if (message) {
      this.#mirrorTerminalContentToAgui(
        this.presenter.emitTerminalMessage({
          sink: resultingStream,
          state: this.state,
          message,
          errorCode,
        }),
      );
    }
    resultingStream.endStream();
    try {
      this.currentContentStream?.endStream();
      this.currentEventStream?.endStream();
      this.currentAguiStream?.endStream();
    } catch (error) {
      logger.error('[Agent] Error ending streams:', { error });
    }

    const outcome: AgentRunOutcome = this.lastRun ?? {
      status: 'aborted',
      history: this.state.getConversationHistory(),
    };

    // Session-aware: persist remaining delta and update status.
    // Messages are already persisted incrementally in callAgent();
    // this handles the final response that triggered stopProcessing.
    let sessionSavePromise: Promise<void> | null = null;
    if (this.activeSessionId && this.sessionManager) {
      const sessionId = this.activeSessionId;
      const runResponseId = this.#activeRunResponseId;
      const sm = this.sessionManager;
      const activeAgentRun = this.#activeAgentRun;
      const status = outcome.status === 'error' ? ('error' as const) : ('idle' as const);

      if (outcome.status !== 'ok') {
        this.#recordPartialAssistantText(sessionId, sm);
      }

      sessionSavePromise = (async () => {
        // Run status reflects LOGICAL completion — write it FIRST so the UI run
        // indicator clears immediately, decoupled from how long durable message
        // persistence takes. The run's `done` promise still awaits the drain
        // below, so callers that await the run get full persistence. Status and
        // durability are SEPARATE steps: a persistence failure must not flip an
        // already-recorded run outcome.
        try {
          await sm.updateStatus(sessionId, status);
          if (runResponseId) {
            await sm.finalizeCurrentRun(sessionId, runResponseId, status);
          }
        } catch (err) {
          logger.warn('[Agent] currentRun status write failed; marking error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          await sm.updateStatus(sessionId, 'error').catch(() => {});
          if (runResponseId) {
            await sm.finalizeCurrentRun(sessionId, runResponseId, 'error').catch(() => {});
          }
        }

        try {
          if (activeAgentRun) {
            await activeAgentRun.catch((err) =>
              logger.warn('[Agent] Active runner settlement failed before session persistence', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          await sm.flushRecording();
          await sm.flushContentRecording();
          if (runResponseId) {
            await sm.stampFinalContentSeq(sessionId, runResponseId).catch((err) =>
              logger.warn('[Agent] finalContentSeq stamp failed', {
                sessionId,
                error: String(err),
              }),
            );
          }
          await sm.finalizeSession(sessionId);
          await this.#persistCompactionIfNeeded(sessionId, sm);
        } catch (err) {
          logger.warn('[Agent] Session persistence (flush/finalize/compaction) failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      })();

      this.activeSessionId = undefined;
      this.#activeRunResponseId = undefined;
      this.#activeAgentService = undefined;
    }

    const resolveRunDone = () => {
      try {
        const maybe = this.onComplete?.({ state: this.state, outcome });
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
          (maybe as Promise<void>).catch((err) =>
            logger.warn('[Agent] onComplete failed', { err }),
          );
        }
      } catch (err) {
        logger.warn('[Agent] onComplete failed', { err });
      }

      this.runDone?.(outcome);
      this.runDone = null;
    };

    if (sessionSavePromise) {
      // Stream is already ended — caller sees response.
      // But handle.done waits for the save to complete (prevents race with next message).
      sessionSavePromise.finally(resolveRunDone);
    } else {
      resolveRunDone();
    }
  }

  /**
   * Durably record the assistant text that was still streaming when the run
   * ended without completing (abort/error), marked `partial: true`. Reuses the
   * messageId the live stream used for its deltas so clients reconcile by id,
   * and enqueues through `recordContent` BEFORE `flushContentRecording` drains
   * so the run's completion cursor (`stampFinalContentSeq`) covers it.
   * Never throws — teardown must not fail on best-effort persistence.
   */
  #recordPartialAssistantText(sessionId: string, sm: SessionManager): void {
    try {
      const pending = this.#activeAgentService?.pendingAssistantText();
      if (!pending || pending.text.length === 0) {
        return;
      }
      sm.recordContent(sessionId, {
        items: [
          createTextContent({
            messageId: pending.messageId,
            responseId: pending.responseId,
            content: pending.text,
          }),
        ],
        partial: true,
      });
    } catch (error) {
      logger.warn('[Agent] Failed to record partial assistant text', { sessionId, error });
    }
  }

  #extractCompactionSummary(): string | null {
    return (
      this.state.getCompactionSummary() ??
      extractCompactionSummary(this.state.getConversationHistory())
    );
  }

  /**
   * The collapsed history to snapshot: system messages, the summary, then every
   * entry from the compaction boundary onward.
   *
   * Rendered here rather than taken from the compaction render, because this
   * runs at turn END: slicing from the boundary picks up everything produced
   * AFTER the firing, which a render frozen at firing time does not. Dropping
   * those was the "cross-turn cache broken" regression.
   *
   * Falls back to kernel history when no boundary was recorded — a compaction
   * from before the boundary existed, or one whose first kept message carried no
   * assigned id.
   */
  #renderCollapsedHistory(summary: string | null): ModelMessage[] {
    const history = this.state.getKernelConversationHistory();
    const boundary = this.state.getCompactionBoundaryMid();
    if (!boundary || summary === null) return history;

    const keptFrom = history.findIndex((message) => readMessageId(message) === boundary);
    if (keptFrom < 0) {
      logger.warn('[Agent] Compaction boundary unresolvable — snapshotting full history', {
        boundary,
        historyLength: history.length,
      });
      return history;
    }

    const systemMessages = history.filter((message) => message.role === 'system');
    const summaryMessage = {
      role: 'user',
      content: [{ type: 'text', text: summary }],
      providerOptions: { agentplace: { injected: true, type: 'compaction-summary' } },
    } as unknown as ModelMessage;

    return [...systemMessages, summaryMessage, ...history.slice(keptFrom)];
  }

  #collectStoredResultPaths(): string[] {
    const paths: string[] = [];
    const history = this.state.getConversationHistory();
    for (const msg of history) {
      // biome-ignore lint/suspicious/noExplicitAny: ModelMessage ≠ LanguageModelV3Message but structurally compatible
      for (const result of getToolResults(msg as any)) {
        const value = getToolResultString(result.output);
        if (value && value.startsWith('[Stored:')) {
          const path = value.slice('[Stored: '.length, -1).trim();
          if (path) paths.push(path);
        }
      }
    }
    return paths;
  }

  /**
   * Surface a blocking-tool answer that resolved nothing.
   *
   * `applyResumeToolResults` matches answers against pending markers found in
   * history. When the marker is absent the answer is simply not applied, and
   * nothing downstream can tell that apart from a turn with no answer — the
   * user clicks an option and the model never learns what they chose.
   *
   * Only THIS turn's answers are checked. Previously resolved answers are
   * replayed from durable storage on every load and are expected to match
   * nothing once their placeholder is resolved, so including them would make
   * this fire on every healthy resume.
   */
  #warnOnUnappliedAnswers(
    sessionId: string,
    fresh: ResumeToolResult[] | undefined,
    resume: ResumeOutcome,
  ): void {
    if (!fresh || fresh.length === 0) {
      return;
    }
    // Resolutions are keyed by entry address, so a fresh answer counts as
    // applied when its output landed on some entry — not by id lookup.
    const applied = new Set(Object.values(resume.resolutions));
    const unapplied = fresh
      .filter((answer) => !applied.has(answer.output))
      .map((answer) => answer.toolCallId);
    if (unapplied.length === 0) {
      return;
    }
    logger.warn('[Agent] Blocking-tool answer matched no pending call — answer not applied', {
      sessionId,
      toolCallIds: unapplied,
      hadPending: resume.hadPending,
      historyLength: resume.history.length,
    });
  }

  /**
   * Persist compaction checkpoint + snapshot if compaction occurred.
   *
   * Takes the session explicitly: by the time the finalize closure reaches this
   * call, `stopProcessing` has already cleared `this.activeSessionId`, so the
   * caller must pass the locals it captured before the closure suspended.
   */
  async #persistCompactionIfNeeded(sessionId: string, sm: SessionManager): Promise<void> {
    if (!this.state.getCompactionOccurred()) {
      return;
    }
    const summary = this.#extractCompactionSummary();
    const storedPaths = this.#collectStoredResultPaths();
    const checkpoint = createCheckpointMessage(
      0,
      summary,
      storedPaths,
      {},
      this.state.getCompactionBoundaryMid(),
    );
    await sm.appendMessage(sessionId, checkpoint);
    await sm.writeSnapshot(
      sessionId,
      this.#renderCollapsedHistory(summary) as Record<string, unknown>[],
    );
    this.state.setCompactionOccurred(false);
    this.state.setCompactionBoundaryMid(null);
    this.state.setCompactionSummary(null);
  }
}
