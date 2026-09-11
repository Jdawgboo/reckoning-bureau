import type { PendingAction, TurnEvent } from './turn-events.ts';

/**
 * Structural subset of a runtime's content type this observer can consume.
 * Lib purity: no `agent-library` import here — a runtime's real content type
 * (e.g. `AgentContent`) is assignable to this shape without a cast, which is
 * what lets ONE observer serve every runtime (deployed, builder, ...).
 */
export interface ObservedContentBase {
  messageId?: string;
  role?: string;
  hidden?: boolean;
  progress?: { text: string };
}

export interface ObservedTextContent extends ObservedContentBase {
  type: 'TXT';
  content: string;
  isReasoning?: boolean;
}

export interface ObservedComponentContent extends ObservedContentBase {
  type: 'Component';
  componentName: string;
  props: Record<string, unknown>;
  fallbackMarkdown?: string;
  streaming?: {
    toolName: string;
    toolCallId: string;
    state: string;
    input?: Record<string, unknown>;
    error?: string;
  };
}

export interface ObservedToolContent extends ObservedContentBase {
  type: 'Tool';
  streaming?: ObservedComponentContent['streaming'];
}

export type ObservedContent =
  | ObservedTextContent
  | ObservedComponentContent
  | ObservedToolContent
  | (ObservedContentBase & { type: string });

/** What a `UIRenderDetector` reports about a rendered component. */
export interface UIRenderDetection {
  component: string;
  pendingAction: PendingAction | null;
  fallbackMarkdown: string | null;
}

/**
 * Runtime-specific policy for recognizing a rendered UI unit worth surfacing
 * as a `ui-rendered` fact. `null` means "plain tool telemetry, nothing to
 * render" — e.g. a data-fetch tool with no on-screen surface.
 */
export interface UIRenderDetector {
  detect(content: ObservedComponentContent): UIRenderDetection | null;
}

export interface TurnObserverDeps {
  runId: string;
  detector: UIRenderDetector;
  emit: (event: TurnEvent) => void;
}

function isTextContent(content: ObservedContent): content is ObservedTextContent {
  return content.type === 'TXT';
}

function isComponentContent(content: ObservedContent): content is ObservedComponentContent {
  return content.type === 'Component';
}

function isToolContent(content: ObservedContent): content is ObservedToolContent {
  return content.type === 'Tool';
}

/**
 * Condenses a session turn's content stream into role-agnostic `TurnEvent`
 * facts — text answers, tool steps, rendered UI, failures, completion. Zero
 * speech decisions: those live in `ResponseSpeechPolicy`. One observer
 * instance per turn.
 */
export class TurnObserver {
  #deps: TurnObserverDeps;
  #textBuffer = '';
  #textMessageId: string | null = null;
  #lastFinalText = '';
  #lastProgressText = '';

  constructor(deps: TurnObserverDeps) {
    this.#deps = deps;
  }

  handle(content: ObservedContent): void {
    if (content.role === 'user' || content.hidden === true) {
      return;
    }
    this.#handleProgress(content);
    if (isTextContent(content)) {
      this.#handleText(content);
      return;
    }
    this.#flushText();
    if (isComponentContent(content) || isToolContent(content)) {
      this.#handleToolLifecycle(content);
    }
  }

  #handleProgress(content: ObservedContent): void {
    const text = content.progress?.text.trim() ?? '';
    if (!text || text === this.#lastProgressText) {
      return;
    }
    this.#lastProgressText = text;
    this.#deps.emit({ type: 'progress', runId: this.#deps.runId, text });
  }

  /** The turn ended without an error — flushes any buffered text and reports it. */
  complete(): void {
    this.#flushText();
    this.#deps.emit({
      type: 'run-finished',
      runId: this.#deps.runId,
      finalText: this.#lastFinalText,
    });
  }

  /** The turn ended with an error — flushes any buffered text, then reports the failure. */
  fail(error: string): void {
    this.#flushText();
    this.#deps.emit({ type: 'run-failed', runId: this.#deps.runId, error });
  }

  #handleText(content: ObservedTextContent): void {
    if (content.isReasoning) {
      return;
    }
    const messageId = content.messageId ?? '';
    if (this.#textMessageId !== null && this.#textMessageId !== messageId) {
      this.#flushText();
    }
    this.#textMessageId = messageId;
    this.#textBuffer += content.content;
  }

  #flushText(): void {
    const text = this.#textBuffer.trim();
    this.#textBuffer = '';
    this.#textMessageId = null;
    if (!text) {
      return;
    }
    this.#lastFinalText = text;
    this.#deps.emit({ type: 'answer-text', runId: this.#deps.runId, text });
  }

  #handleToolLifecycle(content: ObservedComponentContent | ObservedToolContent): void {
    const streaming = content.streaming;
    if (!streaming) {
      return;
    }
    if (streaming.state === 'output-error') {
      return;
    }
    if (streaming.state === 'input-streaming') {
      return;
    }
    if (streaming.state !== 'output-available') {
      return;
    }
    if (isComponentContent(content)) {
      this.#detectUIRender(content, streaming);
    }
    this.#deps.emit({
      type: 'tool-step',
      runId: this.#deps.runId,
      toolName: streaming.toolName,
    });
  }

  #detectUIRender(
    content: ObservedComponentContent,
    streaming: NonNullable<ObservedComponentContent['streaming']>,
  ): void {
    const detection = this.#deps.detector.detect(content);
    if (!detection) {
      return;
    }
    this.#deps.emit({
      type: 'ui-rendered',
      event: {
        runId: this.#deps.runId,
        component: detection.component,
        toolName: streaming.toolName,
        toolCallId: streaming.toolCallId,
        pendingAction: detection.pendingAction,
        fallbackMarkdown: detection.fallbackMarkdown,
      },
    });
  }
}
