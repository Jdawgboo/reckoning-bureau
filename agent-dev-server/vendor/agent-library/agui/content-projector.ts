import { AGUI_CUSTOM_EVENT_NAMES, type AguiEvent, type ToolEventExtension } from './events.ts';
import {
  createComponent,
  createTextContent,
  createToolContent,
  type AgentContent,
  type ToolPartState,
  type UserFacingProgress,
} from '../types/content.ts';
import type { UiSink } from '../kernel/ui-sink.ts';

interface ToolMeta {
  toolName: string;
  componentName?: string;
}

interface ToolPhaseValue {
  toolCallId: string;
  state: 'output-pending';
  toolName?: string;
  componentName?: string;
  input?: Record<string, unknown>;
  inputDelta?: string;
  props?: Record<string, unknown>;
  progress?: UserFacingProgress;
}

interface ToolContentValue {
  toolCallId: string;
  toolName: string;
  state: ToolPartState;
  input?: Record<string, unknown>;
  content?: unknown;
  progress?: UserFacingProgress;
}

interface SourcesValue {
  messageId: string;
  sources: Array<{ url?: string; title?: string }>;
  fallbackMarkdown: string;
}

/**
 * Pure projection: AG-UI events → the exact AgentContent the legacy pipeline
 * appended. Registry-free: all tool-specific decisions (componentName,
 * suppressions, fallbacks) were resolved by the emitter and ride the events.
 */
export class AguiContentProjector {
  readonly #sink: UiSink<AgentContent>;
  readonly #getResponseId: () => string | undefined;
  readonly #tools = new Map<string, ToolMeta>();

  constructor(sink: UiSink<AgentContent>, getResponseId: () => string | undefined) {
    this.#sink = sink;
    this.#getResponseId = getResponseId;
  }

  handle(event: AguiEvent): void {
    switch (event.type) {
      case 'TEXT_MESSAGE_CHUNK':
        this.#sink.append(
          createTextContent({
            messageId: event.messageId,
            responseId: this.#getResponseId(),
            content: event.delta,
            isReasoning: false,
            ...(event.role === 'user' ? { role: 'user' as const } : {}),
          }),
        );
        return;
      case 'REASONING_MESSAGE_CHUNK':
        this.#sink.append(
          createTextContent({
            messageId: event.messageId,
            responseId: this.#getResponseId(),
            content: event.delta,
            isReasoning: true,
          }),
        );
        return;
      case 'TOOL_CALL_START':
        this.#rememberTool(event.toolCallId, event.toolCallName, event.x);
        this.#emitComponent(event.toolCallId, 'input-streaming', { inputDelta: '' });
        return;
      case 'TOOL_CALL_ARGS':
        this.#emitComponent(event.toolCallId, 'input-streaming', { inputDelta: event.delta });
        return;
      case 'TOOL_CALL_END':
        this.#rememberTool(event.toolCallId, undefined, event.x);
        this.#emitComponent(event.toolCallId, 'input-available', {
          input: event.x?.input,
          inputDelta: event.x?.inputDelta,
        });
        return;
      case 'TOOL_CALL_RESULT': {
        this.#rememberTool(event.toolCallId, event.toolCallName, event.x);
        const x = event.x ?? {};
        if (x.isError) {
          this.#emitComponent(event.toolCallId, 'output-error', {
            input: x.input,
            inputDelta: x.inputDelta,
            error: x.errorMessage,
            fallbackText: x.fallbackText,
          });
        } else {
          this.#emitComponent(event.toolCallId, 'output-available', {
            input: x.input,
            inputDelta: x.inputDelta,
            props: x.props,
            fallbackText: x.fallbackText,
            fallbackMarkdown: x.fallbackMarkdown,
            progress: x.progress,
          });
        }
        return;
      }
      case 'CUSTOM':
        this.#handleCustom(event.name, event.value);
        return;
      default:
        // RUN_* / STEP_* lifecycle and STATE_SNAPSHOT / STATE_DELTA — no content
        // projection. STATE rides the same wire but feeds the client's uiState
        // store, never the conversation content stream.
        return;
    }
  }

  #handleCustom(name: string, value: unknown): void {
    if (name === AGUI_CUSTOM_EVENT_NAMES.content) {
      const content = (value as { content?: AgentContent })?.content;
      if (content) {
        this.#sink.append(content);
      }
      return;
    }
    if (name === AGUI_CUSTOM_EVENT_NAMES.toolPhase) {
      const v = value as ToolPhaseValue;
      this.#rememberTool(v.toolCallId, v.toolName, { componentName: v.componentName });
      this.#emitComponent(v.toolCallId, 'output-pending', {
        input: v.input,
        inputDelta: v.inputDelta,
        props: v.props,
        progress: v.progress,
      });
      return;
    }
    if (name === AGUI_CUSTOM_EVENT_NAMES.toolContent) {
      const v = value as ToolContentValue;
      this.#sink.append(
        createToolContent({
          messageId: v.toolCallId,
          responseId: this.#getResponseId(),
          tool: { name: v.toolName },
          content: v.content as Record<string, unknown> | undefined,
          streaming: {
            toolName: v.toolName,
            toolCallId: v.toolCallId,
            state: v.state,
            input: v.input,
          },
          progress: v.progress,
        }),
      );
      return;
    }
    if (name === AGUI_CUSTOM_EVENT_NAMES.sources) {
      const v = value as SourcesValue;
      this.#sink.append(
        createComponent({
          messageId: v.messageId,
          responseId: this.#getResponseId(),
          componentName: 'Sources',
          props: { sources: v.sources },
          fallbackMarkdown: v.fallbackMarkdown,
        }),
      );
      return;
    }
  }

  #rememberTool(toolCallId: string, toolName: string | undefined, x?: ToolEventExtension): void {
    const existing = this.#tools.get(toolCallId);
    this.#tools.set(toolCallId, {
      toolName: toolName ?? x?.toolName ?? existing?.toolName ?? '',
      componentName: x?.componentName ?? existing?.componentName,
    });
  }

  #emitComponent(
    toolCallId: string,
    state: ToolPartState,
    updates: {
      inputDelta?: string;
      input?: Record<string, unknown>;
      error?: string;
      props?: Record<string, unknown>;
      fallbackText?: string;
      fallbackMarkdown?: string;
      progress?: UserFacingProgress;
    },
  ): void {
    const meta = this.#tools.get(toolCallId);
    if (!meta?.componentName) {
      return; // matches legacy: no componentName → no Component content
    }
    this.#sink.append(
      createComponent({
        messageId: toolCallId,
        responseId: this.#getResponseId(),
        componentName: meta.componentName,
        props: updates.props,
        fallbackText: updates.fallbackText,
        fallbackMarkdown: updates.fallbackMarkdown,
        progress: updates.progress,
        streaming: {
          toolName: meta.toolName,
          toolCallId,
          state,
          inputDelta: updates.inputDelta,
          input: updates.input,
          error: updates.error,
        },
      }),
    );
  }
}
