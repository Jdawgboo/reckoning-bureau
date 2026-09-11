import type { SpeechIntent } from './speech-scheduler.ts';
import type { PendingAction, TurnEvent, UIRenderedEvent } from './turn-events.ts';

const MAX_RELAY_SOURCE_CHARS = 1_200;

/** A rendered surface is waiting for the visitor's on-screen action — armed, never auto-answered. */
export interface PendingActionRequest {
  action: PendingAction;
  toolCallId: string;
  toolName: string;
}

export interface ResponseSpeechPolicyDeps {
  runId: string;
  /**
   * Read per event, never captured: a run's origin can be discovered late —
   * the run's first broadcast content can outrace the delegation's
   * acceptance, so the handler that saw content first may have assumed
   * 'screen' for a turn that voice started.
   */
  origin: () => 'voice' | 'screen';
  schedule: (intent: Extract<SpeechIntent, { kind: 'progress' | 'relay' }>) => void;
  onPendingAction: (request: PendingActionRequest) => void;
  onDisarm: () => void;
}

/**
 * Selects committed, user-relevant run facts for speech. Tool lifecycle,
 * reasoning, elapsed time, streaming render input, and nonterminal tool
 * failures never become speech input.
 */
export class ResponseSpeechPolicy {
  #deps: ResponseSpeechPolicyDeps;
  #pendingAction: PendingAction | null = null;
  #terminalSelected = false;

  constructor(deps: ResponseSpeechPolicyDeps) {
    this.#deps = deps;
  }

  onEvent(event: TurnEvent): void {
    if (this.#terminalSelected) {
      return;
    }
    switch (event.type) {
      case 'ui-rendered':
        this.#onUiRendered(event.event);
        return;
      case 'run-failed':
        this.#onRunFailed();
        return;
      case 'run-finished':
        this.#onRunFinished(event.finalText);
        return;
      case 'progress':
        this.#onProgress(event.text);
        return;
      case 'answer-text':
      case 'tool-step':
        return;
    }
  }

  #onProgress(text: string): void {
    if (this.#deps.origin() !== 'voice') {
      return;
    }
    this.#deps.schedule({
      kind: 'progress',
      fact: bounded(text),
      runId: this.#deps.runId,
      coalesceKey: `run:${this.#deps.runId}`,
    });
  }

  #onUiRendered(event: UIRenderedEvent): void {
    const pendingAction = event.pendingAction;
    this.#pendingAction = pendingAction;
    if (!pendingAction) {
      this.#deps.onDisarm();
      return;
    }
    this.#deps.onPendingAction({
      action: pendingAction,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }

  #onRunFailed(): void {
    this.#terminalSelected = true;
    this.#deps.onDisarm();
    this.#pendingAction = null;
    this.#scheduleRelay('The operation ended with an error. Give a brief, nontechnical apology.');
  }

  #onRunFinished(finalText: string): void {
    this.#terminalSelected = true;
    const answer = bounded(finalText);
    if (answer) {
      this.#scheduleRelay(answer);
      return;
    }
    if (this.#pendingAction) {
      this.#scheduleRelay(decisionSource(this.#pendingAction));
    }
  }

  #scheduleRelay(note: string): void {
    this.#deps.schedule({
      kind: 'relay',
      note,
      runId: this.#deps.runId,
      coalesceKey: `run:${this.#deps.runId}`,
    });
  }
}

function decisionSource(action: PendingAction): string {
  const options = action.options.map((option) => option.label).filter(Boolean);
  const optionsLine = options.length > 0 ? `\nOptions: ${options.join(', ')}` : '';
  return bounded(`A user decision is required.\nQuestion: ${action.label}${optionsLine}`);
}

function bounded(value: string): string {
  return value.trim().slice(0, MAX_RELAY_SOURCE_CHARS);
}
