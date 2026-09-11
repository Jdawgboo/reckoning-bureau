/**
 * @agentplace/agent - Agent Runtime Library
 *
 * A library for building AI agents with streaming, tools, and UI integration.
 * Inspired by Vercel AI SDK patterns.
 *
 * @example
 * ```typescript
 * import { ToolModel, Agent, AgentState } from '@agentplace/agent';
 * import { z } from 'zod';
 *
 * const weatherTool = new ToolModel({
 *   toolType: 'function',
 *   name: 'ShowWeather',
 *   description: 'Display weather information',
 *   parametersSchema: z.object({ city: z.string() }),
 *   audience: 'visitor', // output is content addressed to the end user
 * });
 * ```
 */

// =============================================================================
// Core
// =============================================================================

export {
  createAgent,
  type AgentConfig,
  type AgentRunResult,
  type AgentInstance,
} from './create-agent.ts';
export { default as Agent, type AgentParamsT, type AgentRunInput } from './core/agent.ts';
export { default as AgentState } from './core/agent-state.ts';
export type { AgentTurnRequest, AgentKernelTurn } from './core/agent-state.ts';
export type { CreateAgent } from './core/create-agent.ts';
export type {
  Attachment,
  IAgentState,
  CreateAgentParams,
  PrepareStepCallback,
} from './core/interfaces.ts';
export type { StopCondition } from 'ai';
export {
  AgentService,
  type AgentServiceConfig,
  type AgentRunOptions,
  type AgentRunOutcome,
  type StepUsage,
} from './core/agent.service.ts';
export { AgentFactory } from './core/agent.factory.ts';
export {
  type FileFirstConfig,
  DEFAULT_FILE_FIRST_CONFIG,
  offloadToolResult,
  generatePreview,
} from './core/file-first-offloader.ts';
export { formatToolResultForStorage } from './core/tool-result-format.ts';
export { DefaultPresenter } from './defaults/presenter.ts';
export { ToolLoopAgentRunner } from './runners/tool-loop-agent.runner.ts';
export type { FinishReason } from './runners/agent-runner.ts';

// =============================================================================
// Content Types
// =============================================================================

export {
  ContentType,
  type AgentContent,
  type AgentContentBase,
  type TextContent,
  type AudioContent,
  type ToolContent,
  type ComponentContent,
  type ComponentStreaming,
  type ComponentProps,
  type ToolPartState,
  type UserFacingProgress,
  // Factory functions
  createTextContent,
  createAudioContent,
  createToolContent,
  createComponent,
  createStreamingComponent,
  createComponentResult,
  createComponentError,
  // Utilities
  copyContent,
  toComponentProps,
  isComponentContent,
  isStreamingComponent,
  isComponentLoading,
  isComponentStreaming,
  isComponentDone,
  isStreamingDelta,
  isUserContent,
} from './types/content.ts';

export { AgentMode } from './types/mode.ts';
export { generateId, generateShortId } from './types/id.ts';
export {
  AgentRetryError,
  AgentBudgetError,
  EmptyModelResponseError,
  FirstTokenTimeoutError,
  INSUFFICIENT_CREDITS_ERROR_NAME,
  isInsufficientCreditsError,
  LlmErrorCode,
} from './types/errors.ts';
export { type AgentLogger, getAgentLogger, setAgentLogger } from './types/logger.ts';
export { type AgentTracer, getAgentTracer, setAgentTracer } from './types/tracer.ts';
export { CancelableStream } from './types/cancelable-stream.ts';
export {
  type ChannelRenderer,
  type RendererMap,
  type RenderOptions,
  type StreamingMode,
  render,
  shouldRender,
  withTypingIndicator,
  handleChannelStream,
  type ChannelStreamAdapter,
  type ChannelStreamWording,
  type MessageHandle,
  chunkText,
  createChannelSessionStore,
  type ChannelSessionStore,
  type ChannelSessionStoreOptions,
  downloadAttachments,
  defaultAllowType,
  formatRejectedSummary,
  type IncomingAttachmentRef,
  type DownloadOptions,
  type DownloadResult,
} from './channels/index.ts';
export { ContentStream } from './types/content-stream.ts';
export { EventStream, type EventSink } from './types/event-stream.ts';

// =============================================================================
// Tools
// =============================================================================

export {
  ToolModel,
  type ToolType,
  type ToolAudience,
  type FunctionParameters,
  type ToolExecuteResult,
  type ToolExecuteContext,
  type ToolRunnerEvent,
  type ToolOutput,
  type ToolOutputImage,
  type ToolOutputImages,
  type ToolOutputFileContent,
  type ToolOutputMultiContent,
} from './tools/tool-model.ts';

export { ToolRegistry, type IToolRegistry } from './tools/tool-registry.ts';
export { ToolCall } from './tools/tool-call.ts';
export { GetCurrentTimeTool } from './tools/get-current-time-tool.ts';
export {
  getBuiltInTools,
  filterScheduleSafeTools,
  SCHEDULE_MUTATION_TOOL_NAMES,
} from './tools/built-in-tools.ts';
export { GrepTool } from './tools/grep.tool.ts';
export { ReadFilesTool } from './tools/read-files.tool.ts';
export { ListDirectoryTool } from './tools/list-directory.tool.ts';
export {
  type DirectoryTreeNode,
  buildTreeFromRelativeFileList,
  filterStructure,
  limitDepth,
  normalizeBaseDir,
  pruneNoiseDirs,
  structureToText,
} from './util/directory-tree.ts';

export {
  SubagentToolModel,
  createSubagentTool,
  resolveSubagentModelMiddlewares,
  type SubagentConfig,
  type SubagentSpawnContext,
  type SubagentToolConfig,
  type SubagentModelResolution,
} from './tools/subagent-tool.ts';

// =============================================================================
// Kernel
// =============================================================================

export type {
  ToolDefinition,
  ToolInvocationContext,
  ToolKind,
} from './kernel/tooling.ts';

// Re-export FlexibleSchema from AI SDK for consumers defining custom tools
export type { FlexibleSchema } from '@ai-sdk/provider-utils';

export { requireAgentState } from './kernel/require-agent-state.ts';

export type { UiSink } from './kernel/ui-sink.ts';
export type { AgentRunHandle } from './kernel/run-handle.ts';

export type { StopPolicy, RetryPolicy, TurnPolicy } from './kernel/policies.ts';

export type {
  KernelModelMiddleware,
  KernelModelMiddlewareContext,
} from './kernel/middlewares/types.ts';

export { wrapModelWithKernelMiddlewares } from './kernel/middlewares/index.ts';

export type { KernelPresenter } from './kernel/presenter.ts';
export type { AgentKernelEventSink, AgentKernelEvent } from './kernel/events.ts';
export type { TurnProcessor, TurnProcessorState } from './kernel/processors/types.ts';

// =============================================================================
// Utilities
// =============================================================================

export { StreamThrottler } from './kernel/utils/stream-throttler.ts';
export { mergeContentDeltas } from './kernel/utils/merge-content-deltas.ts';
export { isPlainObject } from './kernel/utils/type-guards.ts';
export {
  ComponentPropsResolver,
  createComponentPropsResolver,
  type ResolvedComponentProps,
} from './kernel/utils/component-props-resolver.ts';
export {
  isTextPart,
  isReasoningPart,
  isToolCallPart,
  isToolResultPart,
  getTextContent,
  getReasoningContent,
  getToolCalls,
  getToolResults,
  getToolResultString,
  getAgentplaceMetadata,
  hasAgentplaceType,
  looksLikeBinaryString,
} from './kernel/utils/message-parts.ts';

// =============================================================================
// Telemetry
// =============================================================================

export type {
  TraceOrchestrator,
  TraceRun,
  TraceRunStartParams,
  TraceOrchestratorModelParams,
} from './telemetry/trace-orchestrator.ts';
export {
  LangfuseTraceOrchestrator,
  type RunEndMetadataHook,
} from './telemetry/langfuse-trace-orchestrator.ts';
export { setLangfuseClient, getLangfuseTraceOrchestrator } from './telemetry/langfuse.ts';

// =============================================================================
// Runners
// =============================================================================

export type {
  AgentRunner,
  AgentRunnerHandle,
  AgentRunnerRunOptions,
  AgentStreamEvent,
} from './runners/agent-runner.ts';

// =============================================================================
// Defaults (built-in policies, middlewares, processors)
// =============================================================================

export {
  stopPolicy,
  retryPolicy,
  turnPolicy,
  policies as defaultPolicies,
} from './defaults/policies.ts';

export { TurnsLimitMiddleware } from './defaults/middlewares/turns-limit.middleware.ts';
export { FinalPromptCaptureMiddleware } from './defaults/middlewares/final-prompt-capture.middleware.ts';
export {
  CompactionMiddleware,
  type CompactionOptions,
  type CollapsedPairInfo,
  type CollapseSummaryContext,
  defaultCollapseSummary,
} from './defaults/middlewares/compaction.middleware.ts';
export {
  validateCollapseSummary,
  type SummaryValidation,
} from './defaults/middlewares/summary-validation.ts';
export {
  buildCompactionHistoryPointer,
  generateSummaryWithFallback,
  nextCompactionHistoryPath,
  stripCompactionHistoryPointers,
  stripModelSummaryWrapper,
  usablePreviousSummary,
  type CompactionHistoryStorage,
  type SummaryGenerationResult,
} from './defaults/middlewares/compaction-history.ts';
export {
  serializeMessagesForSummary,
  serializeMessagesForNarrative,
} from './defaults/middlewares/serialize-messages.ts';
export {
  INITIAL_SUMMARY_PROMPT,
  UPDATE_SUMMARY_PROMPT,
  extractCompactionSummary,
} from './defaults/middlewares/compaction-summarizer.ts';
export {
  DEFAULT_TOOL_OUTPUT_CHAR_LIMIT,
  applyToolOutputCharLimit,
  capToolResultOutput,
  wrapAiSdkToolWithOutputCap,
} from './defaults/middlewares/tool-output-limit.ts';
export { ReasoningStreamFixMiddleware } from './defaults/middlewares/reasoning-stream-fix.middleware.ts';
export {
  ContextBudgetGuardMiddleware,
  type ContextBudgetGuardOptions,
} from './defaults/middlewares/context-budget-guard.middleware.ts';
export {
  HeuristicTokenEstimator,
  type TokenEstimator,
  type TokenEstimationResult,
} from './util/token-estimator.ts';
export { LastUsageTokenEstimator } from './util/last-usage-token.estimator.ts';
export {
  AnthropicCountTokensEstimator,
  type AnthropicMessagesClient,
  type AnthropicCountTokensEstimatorOptions,
} from './util/anthropic-count-tokens.estimator.ts';
export {
  OpenAICountTokensEstimator,
  type OpenAIResponsesClient,
  type OpenAICountTokensEstimatorOptions,
} from './util/openai-count-tokens.estimator.ts';
export {
  GeminiCountTokensEstimator,
  type GeminiModelsClient,
  type GeminiCountTokensEstimatorOptions,
} from './util/gemini-count-tokens.estimator.ts';
export {
  BedrockCountTokensEstimator,
  type BedrockRuntimeCountTokensClient,
  type BedrockCountTokensEstimatorOptions,
} from './util/bedrock-count-tokens.estimator.ts';
export {
  type CacheHintConfig,
  DEFAULT_CACHE_HINT_CONFIG,
  annotateCacheHints,
} from './defaults/middlewares/cache-hint-annotation.ts';
export { isStoredReference } from './defaults/middlewares/tool-result-compaction.ts';
export {
  TurnInputProcessor,
  type TurnInputProcessorConfig,
} from './defaults/processors/turn-input.processor.ts';
export { SystemPromptProcessor } from './defaults/processors/system-prompt.processor.ts';
export { HistoryDoctorProcessor } from './defaults/processors/history-doctor.processor.ts';
export { VendorCompatibilityProcessor } from './defaults/processors/vendor-compatibility.processor.ts';

export {
  FileContentEncoder,
  type FileEncoderConfig,
  omitTextContentBySize,
  type AttachmentExtended,
  type FileEncodedContent,
  type FileContentMask,
  FILE_ENCODER_SUPPORTED_EXTENSIONS,
  FILE_ENCODER_SUPPORTED_MIME_TYPES,
  ImageCodec,
  PdfCodec,
  type PdfCodecMode,
  WordCodec,
  ExcelCodec,
  TextCodec,
} from './files/index.ts';

// Text extensions list
export { textExtensions } from './util/extensions.ts';

// JSON Schema sanitizer — guarantees every array node has `items` (Gemini/Vertex requirement)
export { ensureArrayItems, DEFAULT_ARRAY_ITEMS } from './util/ensure-array-items.ts';

// =============================================================================
// Streaming Protocol (wire format between server ↔ client)
// =============================================================================

export type {
  StreamEventNotification,
  StreamEndNotification,
  StreamErrorNotification,
  StreamNotification,
  SubscribeAction,
  ResumeAction,
  AbortAction,
  StreamAction,
  CatchUpResult,
} from './streaming/protocol.ts';

export { RetryLoop, type RetryLoopDeps, type RetryLoopOptions } from './streaming/retry-loop.ts';

// =============================================================================
// Replay Buffer (streaming event buffer + resume)
// =============================================================================

export type {
  StreamMetadata,
  StartStreamOptions,
  StreamEventMessage,
  StreamTransport,
  CatchUpOptions,
  IReplayBuffer,
} from './replay-buffer/types.ts';

export { AbstractReplayBuffer } from './replay-buffer/abstract-replay-buffer.ts';
export {
  MemoryReplayBuffer,
  type MemoryReplayBufferOptions,
} from './replay-buffer/memory-replay-buffer.ts';

// =============================================================================
// Cache (prompt caching strategies)
// =============================================================================

export {
  // Interface
  type CacheStrategy,
  // Base classes
  AbstractCacheStrategy,
  NoCacheStrategy,
  // Anthropic/Claude strategies
  ClaudeCacheStrategy,
  type ClaudeCacheStrategyConfig,
  BedrockCacheStrategy,
  type BedrockCacheStrategyConfig,
  OpenRouterClaudeCacheStrategy,
  // Factory
  CacheStrategyFactory,
  type CacheStrategyFactoryConfig,
  // Middleware
  CacheStrategyMiddleware,
  type CacheStrategyMiddlewareConfig,
} from './cache/index.ts';

// =============================================================================
// Storage (adapter-based storage system)
// =============================================================================

export {
  // Main class
  AgentStorage,
  // Types
  type NamedAdapter,
  type AgentStorageParams,
  type StorageReadOptions,
  type StorageWriteOptions,
  type StorageWriteResult,
  type StorageFileMetadata,
  type AdapterFileMetadata,
  type RawFileMetadata,
  // Adapters
  AbstractStorageAdapter,
  AgentPlaceApiAdapter,
  LocalFileSystemAdapter,
  InMemoryAdapter,
  type AgentPlaceApiAdapterParams,
  type LocalFileSystemAdapterParams,
  // Errors
  StorageError,
  StorageFileNotFoundError,
  StorageAdapterNotFoundError,
  StorageNoWritableAdapterError,
  StorageApiError,
  StorageLocalError,
  // Cache
  StorageCache,
  type StorageCacheParams,
  // Utilities
  getMimeType,
} from './storage/index.ts';

// =============================================================================
// State (agent ↔ platform connection)
// =============================================================================

export {
  StateConnection,
  type StateConnectionOptions,
  type IStateTransport,
  type IStateTransportAdapter,
} from './state/state-connection.ts';

export { StateTree } from './state/state-tree.ts';
export type { IStateNode, LoadOptions } from './state/state-node-types.ts';
export { SessionsAccessor, SessionNode, DataAccessor } from './state/accessors.ts';
export { RpcStateBackend } from './state/rpc-state-backend.ts';
export { InMemoryStateBackend } from './state/in-memory-state-backend.ts';
export { globMatch } from './state/glob-match.ts';
export type {
  StateChangeEvent,
  StateBackend,
  PathRule,
  Unsubscribe,
} from './state/types.ts';

// =============================================================================
// Events (inbox pipeline, trigger handlers)
// =============================================================================

export {
  EventProcessor,
  type EventProcessorOptions,
} from './events/event-processor.ts';

export {
  TriggerDispatcher,
  type TriggerDispatcherOptions,
} from './events/trigger-dispatcher.ts';

export {
  ScheduleDispatcher,
  type ScheduleDispatcherOptions,
} from './events/schedule-dispatcher.ts';

export { EventRouter, type EventRegistration } from './events/event-router.ts';

export { TriggerRouter } from './events/trigger-router.ts';

export { ScheduleRouter } from './events/schedule-router.ts';

export type {
  CronKind,
  EveryKind,
  AtKind,
  ScheduleKind,
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScheduleEvent,
  ScheduleContext,
  ScheduleHandler,
  ScheduleLlmOptions,
  ScheduleLlmResult,
  ScheduleRegistrationOptions,
  ScheduleRegistration,
  ScheduleLlmFunction,
  UnhandledScheduleCallback,
  ScheduleReplyTarget,
} from './events/schedule-types.ts';

export {
  isOneTime,
  isRecurring,
  isValidHandlerName,
  isLikelyValidCronExpression,
  isValidIanaTimeZone,
  DEFAULT_HANDLER,
  HANDLER_NAME_PATTERN,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_CRON_EXPR_LENGTH,
  MAX_TZ_NAME_LENGTH,
  MAX_PARAMS_JSON_BYTES,
  MAX_AGENT_SCHEDULES,
  SCHEDULE_STATE_PREFIX,
  SCHEDULE_STATE_PATH_RE,
  scheduleStatePath,
} from './events/schedule-types.ts';

export {
  ChannelHandler,
  type ChannelHandlerOptions,
  type ChannelMessage,
  type ChannelReply,
  type ChannelAgentRunner,
} from './events/channel-handler.ts';

export {
  DeliveryService,
  type DeliveryServiceOptions,
  type DeliveryResult,
  type OutboundChannelAdapter,
} from './events/delivery-service.ts';

export {
  InboxReconciler,
  type InboxReconcilerOptions,
} from './events/inbox-reconciler.ts';

export type {
  TriggerEvent,
  TriggerContext,
  TriggerHandler,
  TriggerLlmOptions,
  TriggerLlmResult,
  TriggerRegistrationOptions,
  TriggerRegistration,
  UnhandledTriggerCallback,
} from './events/types.ts';

// =============================================================================
// Sessions (per-session conversation management)
// =============================================================================

export { SessionManager } from './sessions/session-manager.ts';
export { SessionQueue, type SessionQueueOptions } from './sessions/session-queue.ts';
export { userMessageIdFor } from './sessions/user-message-id.ts';
export {
  SESSION_ID_PATTERN,
  MAX_SESSION_ID_LENGTH,
  isValidSessionId,
  describeSessionIdViolation,
} from './sessions/session-id.ts';
export {
  resolveRunStatus,
  DEFAULT_RUN_GRACE_MS,
  type RunStatus,
  type CurrentRun,
  type ResolveRunStatusInput,
} from './sessions/resolve-run-status.ts';
export type {
  SessionSummary,
  SessionType,
  SessionStatus,
  SessionLocaleSource,
  SessionPresentationLocale,
  ConversationMessage,
  ActivityEntry,
} from './sessions/types.ts';
export {
  createCheckpointMessage,
  readCheckpointData,
  CHECKPOINT_TYPE,
  isCheckpointMessage,
  type CheckpointData,
} from './sessions/checkpoint.ts';

export {
  HistoryValidationMiddleware,
  type HistoryValidationMode,
  type HistoryValidationOptions,
} from './defaults/middlewares/history-validation.middleware.ts';

export { insertInjections, findSafeInjectionPosition } from './core/inject-messages.ts';

export { InterleavedThinkingFixMiddleware } from './defaults/middlewares/interleaved-thinking-fix.middleware.ts';
export { BrokenToolInputFixMiddleware } from './defaults/middlewares/broken-tool-input-fix.middleware.ts';

export { VendorCompatibilityMiddleware } from './defaults/middlewares/vendor-compatibility.middleware.ts';
