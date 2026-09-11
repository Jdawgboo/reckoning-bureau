/**
 * Role-agnostic event contract emitted by the shared TurnObserver. "ui-rendered"
 * covers ANY rendered UI unit — an A2UI surface in the agent runtime, a
 * builder tool component in the dashboard.
 */

export interface PendingAction {
  component: string;
  label: string;
  /** Builder detector fills these; deployed events leave it empty. */
  options: Array<{ label: string; value: string }>;
  /** Non-null when the user's answer resolves a paused tool call. */
  resume: { toolCallId: string } | null;
}

export interface UIRenderedEvent {
  runId: string;
  component: string;
  /** Real tool name from streaming (e.g. RenderForm, SelectOption) — never fabricated downstream. */
  toolName: string;
  toolCallId: string;
  pendingAction: PendingAction | null;
  fallbackMarkdown: string | null;
}

export type TurnEvent =
  | { type: 'answer-text'; runId: string; text: string }
  | { type: 'progress'; runId: string; text: string }
  | { type: 'ui-rendered'; event: UIRenderedEvent }
  | { type: 'tool-step'; runId: string; toolName: string }
  | { type: 'run-failed'; runId: string; error: string }
  | { type: 'run-finished'; runId: string; finalText: string };
