import { parse } from 'best-effort-json-parser';
import type { z } from 'zod';
import type { Tool as AiSdkTool } from 'ai';
import type { ToolCall } from './tool-call.ts';
import type { UiSink } from '../kernel/ui-sink.ts';
import type { ToolDefinition, ToolInvocationContext, ToolKind } from '../kernel/tooling.ts';
import type { HeadlessBlockingPolicy } from '../core/blocking.ts';
import type { SessionType } from '../sessions/types.ts';
import type { UserFacingProgress } from '../types/content.ts';

// Re-export from types for backward compatibility
export type {
  ToolOutput,
  ToolOutputImage,
  ToolOutputImages,
  ToolOutputFileContent,
  ToolOutputMultiContent,
} from '../types/tool-output.ts';
import type { ToolOutput } from '../types/tool-output.ts';

export type ToolType = 'function' | 'web_search' | 'image_generation' | 'mcp' | 'code_execution';

/**
 * Who a tool's OUTPUT is addressed to — never how it renders (hosts decide
 * realization per channel).
 * - `'model'` (default): output returns to the agent loop; any UI shown for it
 *   is host-authored observability of tool execution.
 * - `'visitor'`: the output IS the deliverable, content addressed to the end
 *   user (e.g. rendered screens). Policy filters read this — subagents never
 *   get visitor-audience tools (the parent owns the visitor-facing voice).
 * Litmus: run the tool with no UI host anywhere — did it still accomplish its
 * purpose? Yes → 'model'. No → 'visitor'.
 */
export type ToolAudience = 'model' | 'visitor';

/**
 * Type for tool parameters.
 * Supports both Zod schemas and AI SDK FlexibleSchema.
 */
export type ToolParameters = z.ZodTypeAny | { _type: any };

export type ToolRunnerEvent =
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: unknown };

/**
 * Result returned by the new execute() API.
 */
export interface ToolExecuteResult {
  /**
   * Tool output returned to the LLM.
   * Can be:
   * - string: Text output
   * - ToolOutputImage: Binary image data that the LLM can process visually
   * - ToolOutputFileContent: Binary file data for LLM processing
   */
  output: ToolOutput;
  /** Extra props for UI rendering (e.g., previousContent, newContent) */
  uiProps?: Record<string, unknown>;
  /**
   * Markdown projection of the tool's product for consumers without a native
   * renderer (channel adapters, API/MCP callers, reload reconstruction). The
   * kernel stamps it onto the emitted ComponentContent — the RECORD layer —
   * and derives `fallbackText` from it. It is never appended to the
   * model-visible `output` (the model authored or already knows the content;
   * echoing it would duplicate it in model history).
   */
  fallbackMarkdown?: string;
  /** Confirmed progress suitable for any user-facing channel while the run continues. */
  progress?: UserFacingProgress;
  /** `'pending'` pauses the turn for user input; `output` is the placeholder result. */
  status?: 'pending';
}

/**
 * Context passed to the execute() method.
 * Simplified from ToolInvocationContext - no contentStream access.
 */
export interface ToolExecuteContext {
  /** Agent runner state (for accessing app state) */
  runner: ToolInvocationContext<unknown>['runner'];
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Unique identifier for this tool call */
  toolCallId: string;
  /**
   * Emit an intermediate update on the existing content stream. `props` is
   * presentation data; `progress` is the optional channel-neutral fact.
   */
  onProgress?: (props: Record<string, unknown>, progress?: UserFacingProgress) => void;
  /** Stream text/reasoning deltas into the parent content stream.
   *  Kernel handles messageId prefixing and responseId assignment. */
  streamText?: (delta: { type: 'text' | 'reasoning'; text: string; messageId: string }) => void;
  /** Current session ID (if the agent is running within a session). */
  sessionId?: string;
  /** The run's session type ('web' has a live viewer; everything else is
   *  headless). Lets a tool report truthfully whether its product was
   *  displayed or delivered as a projection. */
  sessionType?: SessionType;
  /** Emit a CUSTOM event onto the run's native AG-UI stream (generic
   *  runtime capability; payload semantics are the caller's). */
  emitCustomEvent?: (name: string, value: unknown) => void;
}

const defaultParsingFn = (args: string): unknown => {
  try {
    return parse(args);
  } catch {
    return null;
  }
};

export type FunctionParameters = Record<string, unknown>;

export class ToolModel<TParams = any> {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: ToolParameters;
  readonly toolType: ToolType;
  readonly parsingFn: (args: string) => unknown;
  public readonly isStrict: boolean;
  public readonly isStreaming: boolean;
  public readonly requiresAgenticFeedback: boolean;
  public readonly outputCharLimit?: number;
  /** When true, file-first offloading is skipped — output always stays inline. */
  public readonly skipOffload: boolean;
  /** Headless blocking policy for a `pending`-returning tool. */
  private readonly headlessPolicy?: HeadlessBlockingPolicy;
  /** Who the tool's output is addressed to (see ToolAudience). */
  private readonly audience?: ToolAudience;

  constructor(config: {
    toolType: ToolType;
    name: string;
    description?: string;
    parametersSchema: ToolParameters;
    isStrict?: boolean;
    isStreaming?: boolean;
    requiresAgenticFeedback?: boolean;
    parsingFn?: (args: string) => unknown;
    outputCharLimit?: number;
    skipOffload?: boolean;
    headless?: HeadlessBlockingPolicy;
    audience?: ToolAudience;
  }) {
    this.name = config.name;
    this.description = config.description ?? '';
    this.parametersSchema = config.parametersSchema;
    this.toolType = config.toolType;
    this.parsingFn = config.parsingFn ?? defaultParsingFn;
    this.isStrict = config.isStrict ?? false;
    this.isStreaming = config.isStreaming ?? false;
    this.requiresAgenticFeedback = config.requiresAgenticFeedback ?? false;
    this.outputCharLimit = config.outputCharLimit;
    this.skipOffload = config.skipOffload ?? false;
    this.headlessPolicy = config.headless;
    this.audience = config.audience;
  }

  getHeadlessPolicy(): HeadlessBlockingPolicy | undefined {
    return this.headlessPolicy;
  }

  getAudience(): ToolAudience {
    return this.audience ?? 'model';
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return this.description;
  }

  getParametersSchema(): ToolParameters {
    return this.parametersSchema;
  }

  /**
   * Deprecated legacy shape for older OpenAI direct-call integrations.
   * New code should use `getParametersSchema()`.
   */
  getParameters(): FunctionParameters {
    return {};
  }

  getToolType(): ToolType {
    return this.toolType;
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parametersSchema as any,
      strict: this.isStrict,
      kind: this.toolType as ToolKind,
    };
  }

  getAiSdkTool(): AiSdkTool<unknown, unknown> | null {
    return null;
  }

  getParsingFn(): (args: string) => unknown {
    return this.parsingFn;
  }

  onRunnerToolEvent(
    _event: ToolRunnerEvent,
    _ui: UiSink,
    _ctx: ToolInvocationContext<unknown>,
  ): void {
    // no-op by default
  }

  /**
   * Main execution method for the tool (legacy API).
   * Receives full agent context including the actual UI content stream.
   *
   * @deprecated New tools should implement execute() instead.
   * The kernel will automatically manage the ToolPart state machine.
   *
   * Tools implementing execute() do not need to implement call() -
   * the default implementation throws an error.
   */
  call(
    _toolCall: ToolCall<TParams>,
    _ui: UiSink,
    _ctx: ToolInvocationContext<unknown>,
  ): Promise<unknown> {
    throw new Error(`${this.name} uses execute() API. call() should not be invoked directly.`);
  }

  /**
   * Simplified execution method (new API).
   *
   * When implemented, the kernel manages the ToolPart state machine:
   * - input-streaming: Kernel emits deltas as LLM generates args
   * - input-available: Kernel emits when args are complete
   * - output-pending: Kernel emits before calling execute()
   * - output-available/output-error: Kernel emits based on execute() result
   *
   * Tools implementing execute() should NOT call contentStream.append().
   *
   * @param input - Parsed and validated tool arguments
   * @param ctx - Simplified execution context
   * @returns Result with output string and optional UI props
   */
  execute?(input: TParams, ctx: ToolExecuteContext): Promise<ToolExecuteResult>;

  /**
   * Check if this tool uses the new execute() API.
   */
  hasExecute(): boolean {
    return typeof this.execute === 'function';
  }

  /**
   * Opt out of partial-input parsing for this instance. Defining
   * `streamPartialInput` is the coarse gate; a tool whose hook exists but
   * cannot do anything useful for the current configuration (e.g. a
   * contract with no progressive composition) sets this to `false` so the
   * kernel skips the per-delta JSON parse entirely. `undefined` means
   * "parse when the hook exists" — the default.
   */
  wantsPartialInput?: boolean;

  /**
   * Called during input streaming with the best-effort-parsed accumulated
   * partial tool input, so a tool can emit progressive UI before execute()
   * runs. `emit` rides the same AG-UI custom-event path as
   * `ToolExecuteContext.emitCustomEvent`.
   *
   * The kernel calls this on every input delta (see
   * `AgentService.handleToolInputDelta`), always with the FULL accumulated
   * partial, never just the newest fragment. Implementations MUST be
   * side-effect-safe and idempotent-tolerant: expect to be called many
   * times with a growing superset of the same data, including malformed or
   * incomplete JSON fragments, and never assume a given call is the last
   * one — `execute()` remains the sole authoritative emitter.
   */
  streamPartialInput?(
    partial: unknown,
    emit: (name: string, value: unknown) => void,
    ctx: { toolCallId: string },
  ): void;

  /**
   * Get the UI component name for this tool.
   * Override in component tools to specify which component to render.
   * Returns null for non-component tools.
   */
  getComponentName(_toolCallId?: string): string | null {
    return null;
  }
}
