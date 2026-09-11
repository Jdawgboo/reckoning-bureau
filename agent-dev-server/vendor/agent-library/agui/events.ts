/**
 * AG-UI-shaped internal event vocabulary (spec: docs.ag-ui.com).
 * Standard event names verbatim; Agentplace-specific payloads ride the
 * optional `x` extension field or CUSTOM events under the `agentplace.*`
 * namespace. This union is the authoritative internal stream; AgentContent
 * is derived from it by AguiContentProjector.
 */

import type { UserFacingProgress } from '../types/content.ts';

/** Extension payload carried on tool events — resolved by the service (registry-aware). */
export interface ToolEventExtension {
  componentName?: string;
  /**
   * The runner tool name (→ ComponentStreaming.toolName). Carried on every tool
   * event so the projector can remember tool metadata regardless of which event
   * arrives first — non-streaming component tools skip TOOL_CALL_START, making
   * TOOL_CALL_END (or a toolPhase) the first contact.
   */
  toolName?: string;
  props?: Record<string, unknown>;
  input?: Record<string, unknown>;
  inputDelta?: string;
  fallbackText?: string;
  fallbackMarkdown?: string;
  isError?: boolean;
  errorMessage?: string;
  progress?: UserFacingProgress;
}

export interface TextMessageChunkEvent {
  type: 'TEXT_MESSAGE_CHUNK';
  messageId: string;
  delta: string;
  role: 'assistant' | 'user';
}

export interface ReasoningMessageChunkEvent {
  type: 'REASONING_MESSAGE_CHUNK';
  messageId: string;
  delta: string;
}

export interface ToolCallStartEvent {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolCallName: string;
  x?: ToolEventExtension;
}

export interface ToolCallArgsEvent {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  delta: string;
  x?: ToolEventExtension;
}

export interface ToolCallEndEvent {
  type: 'TOOL_CALL_END';
  toolCallId: string;
  x?: ToolEventExtension;
}

export interface ToolCallResultEvent {
  type: 'TOOL_CALL_RESULT';
  messageId: string;
  toolCallId: string;
  toolCallName: string;
  /** Model-facing content is NOT carried here (spec: UI gets props, model gets history). */
  content: '';
  x?: ToolEventExtension;
}

export interface StepStartedEvent {
  type: 'STEP_STARTED';
  stepName: string;
}

export interface StepFinishedEvent {
  type: 'STEP_FINISHED';
  stepName: string;
}

export interface RunStartedEvent {
  type: 'RUN_STARTED';
  runId: string;
  threadId?: string;
  parentRunId?: string;
}

export interface RunFinishedEvent {
  type: 'RUN_FINISHED';
  x?: { status: 'ok' | 'aborted'; stoppedByToolName?: string };
}

export interface RunErrorEvent {
  type: 'RUN_ERROR';
  message: string;
}

export interface StateSnapshotEvent {
  type: 'STATE_SNAPSHOT';
  /** JSON Pointer root this snapshot replaces (e.g. '/uiState' or a surface path). */
  scope: string;
  /** Full state value at `scope`. */
  snapshot: unknown;
}

export interface StateDeltaEvent {
  type: 'STATE_DELTA';
  scope: string;
  /** RFC 6902 JSON-Patch operations against `scope`. */
  patch: Array<{ op: string; path: string; value?: unknown; from?: string }>;
}

export interface CustomEvent {
  type: 'CUSTOM';
  name: string;
  value: unknown;
}

export type AguiEvent =
  | TextMessageChunkEvent
  | ReasoningMessageChunkEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StepStartedEvent
  | StepFinishedEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | CustomEvent;

const EVENT_TYPES = new Set<string>([
  'TEXT_MESSAGE_CHUNK',
  'REASONING_MESSAGE_CHUNK',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'STEP_STARTED',
  'STEP_FINISHED',
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'CUSTOM',
]);

export function isAguiEvent(value: unknown): value is AguiEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as Record<string, unknown>)['type'];
  return typeof type === 'string' && EVENT_TYPES.has(type);
}

/**
 * Well-known CUSTOM event names — the AG-UI CUSTOM events Agentplace owns.
 * Referenced as constants (not string literals) so a typo is a compile error,
 * not a silently dropped event.
 */
export const AGUI_CUSTOM_EVENT_NAMES = {
  /** Lossless AgentContent envelope for emission sites not yet natively mapped. */
  content: 'agentplace.content',
  /** output-pending / progress phases of a tool execution (no standard AG-UI event). */
  toolPhase: 'agentplace.toolPhase',
  /** Non-UI tool lifecycle observation (today's ToolContent). */
  toolContent: 'agentplace.toolContent',
  /** Step-end citations flush (today's Sources component). */
  sources: 'agentplace.sources',
} as const;

export const aguiEvent = {
  textChunk(p: {
    messageId: string;
    delta: string;
    role?: 'assistant' | 'user';
  }): TextMessageChunkEvent {
    return {
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: p.messageId,
      delta: p.delta,
      role: p.role ?? 'assistant',
    };
  },
  reasoningChunk(p: { messageId: string; delta: string }): ReasoningMessageChunkEvent {
    return { type: 'REASONING_MESSAGE_CHUNK', messageId: p.messageId, delta: p.delta };
  },
  toolCallStart(p: {
    toolCallId: string;
    toolCallName: string;
    x?: ToolEventExtension;
  }): ToolCallStartEvent {
    return {
      type: 'TOOL_CALL_START',
      toolCallId: p.toolCallId,
      toolCallName: p.toolCallName,
      x: p.x,
    };
  },
  toolCallArgs(p: {
    toolCallId: string;
    delta: string;
    x?: ToolEventExtension;
  }): ToolCallArgsEvent {
    return { type: 'TOOL_CALL_ARGS', toolCallId: p.toolCallId, delta: p.delta, x: p.x };
  },
  toolCallEnd(p: { toolCallId: string; x?: ToolEventExtension }): ToolCallEndEvent {
    return { type: 'TOOL_CALL_END', toolCallId: p.toolCallId, x: p.x };
  },
  toolCallResult(p: {
    toolCallId: string;
    toolCallName: string;
    messageId?: string;
    x?: ToolEventExtension;
  }): ToolCallResultEvent {
    return {
      type: 'TOOL_CALL_RESULT',
      messageId: p.messageId ?? p.toolCallId,
      toolCallId: p.toolCallId,
      toolCallName: p.toolCallName,
      content: '',
      x: p.x,
    };
  },
  stepStarted(index: number): StepStartedEvent {
    return { type: 'STEP_STARTED', stepName: `step-${index}` };
  },
  stepFinished(index: number): StepFinishedEvent {
    return { type: 'STEP_FINISHED', stepName: `step-${index}` };
  },
  runStarted(p: { runId: string; threadId?: string; parentRunId?: string }): RunStartedEvent {
    return {
      type: 'RUN_STARTED',
      runId: p.runId,
      threadId: p.threadId,
      parentRunId: p.parentRunId,
    };
  },
  runFinished(x: { status: 'ok' | 'aborted'; stoppedByToolName?: string }): RunFinishedEvent {
    return { type: 'RUN_FINISHED', x };
  },
  runError(message: unknown): RunErrorEvent {
    return {
      type: 'RUN_ERROR',
      message: message instanceof Error ? message.message : String(message),
    };
  },
  stateSnapshot(p: { scope: string; snapshot: unknown }): StateSnapshotEvent {
    return { type: 'STATE_SNAPSHOT', scope: p.scope, snapshot: p.snapshot };
  },
  stateDelta(p: { scope: string; patch: StateDeltaEvent['patch'] }): StateDeltaEvent {
    return { type: 'STATE_DELTA', scope: p.scope, patch: p.patch };
  },
  custom(name: string, value: unknown): CustomEvent {
    return { type: 'CUSTOM', name, value };
  },
} as const;
