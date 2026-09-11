import type { TurnEvent, UIRenderedEvent } from './turn-events.ts';
import { projectScreen } from './screen-projection.ts';

/** The screen block is re-sent and re-billed on EVERY utterance, so it is
 *  budgeted rather than unbounded. */
const DEFAULT_SCREEN_BUDGET_CHARS = 600;

const MAX_REQUEST_CHARS = 120;
const MAX_ANSWER_CHARS = 300;
const MAX_SUMMARY_CHARS = 400;
const INTERRUPTED_DELIVERY = 'voice response was interrupted before completion';
const UNCONFIRMED_DELIVERY = 'voice delivery could not be confirmed';
const SCREEN_TRUNCATION_MARKER = ' … [screen text truncated]';

/** How long a pending ledger write waits for browser delivery evidence. */
const PARK_TIMEOUT_MS = 30_000;

export type VoiceTimerHandle = ReturnType<typeof setTimeout>;

export type VoiceScreenSnapshot =
  | {
      kind: 'structured';
      sections: ReadonlyArray<{ component: string; props: Record<string, unknown> }>;
      values: Record<string, unknown>;
      fallbackMarkdown?: string;
      isSensitive?: (fieldId: string) => boolean;
    }
  | { kind: 'text'; text: string };

export type VoiceScreenCapability =
  | { kind: 'live'; read: () => VoiceScreenSnapshot | null }
  | { kind: 'summary' }
  | { kind: 'absent' };

export interface VoiceContextProjectorDeps {
  /** Appends one line to the context ledger the builder/agent prompt reads back. */
  appendLedger: (line: string) => void;
  /** Runtime's markdown-to-plain-text helper — injected for lib purity. */
  stripMarkdown: (markdown: string) => string;
  /** Explicit attachment capability; historical surfaces never imply a live screen. */
  screen: VoiceScreenCapability;
  /** Character budget for the screen block — it is re-billed on every utterance. */
  screenBudgetChars?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Timer overrides for tests — default to global `setTimeout`/`clearTimeout`. */
  setTimer?: (callback: () => void, delayMs: number) => VoiceTimerHandle;
  clearTimer?: (handle: VoiceTimerHandle) => void;
}

interface RunState {
  requestText: string | null;
  surface: Surface | null;
  /**
   * Whether this run's answer will be spoken at all. A run the visitor drove
   * from the screen is never relayed, so waiting for spoken-delivery evidence
   * about it waits forever — and then records the answer as undelivered, when
   * in fact they read it themselves.
   */
  spoken: boolean;
}

interface Surface {
  component: string;
  summary: string;
}

interface ParkedAnswer {
  requestText: string | null;
  answer: string;
  timer: VoiceTimerHandle;
}

function clamp(text: string, maxChars: number): string {
  return text.trim().slice(0, maxChars);
}

function clampScreenText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= SCREEN_TRUNCATION_MARKER.length) {
    return SCREEN_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${trimmed.slice(0, maxChars - SCREEN_TRUNCATION_MARKER.length)}${SCREEN_TRUNCATION_MARKER}`;
}

function requestPhrase(requestText: string | null): string {
  return requestText === null ? 'visitor asked (on screen)' : `visitor asked "${requestText}"`;
}

function deliveredLine(kind: string, requestText: string | null, body: string): string {
  return `Delivered (${kind}): ${requestPhrase(requestText)} — ${body}`;
}

/**
 * Role-blind CONTEXT half of the voice architecture — consumes the same
 * `TurnEvent`s as `ResponseSpeechPolicy` but writes what was delivered to the
 * conversation ledger instead of scheduling speech. Owns two facts: a
 * "Delivered: …" line per run once its outcome is known, and the current
 * on-screen surface for prompt injection via `screenStateBlock()`.
 *
 * Race-safe by design: a run that closes with spoken text is PARKED rather
 * than written immediately, because the caller doesn't yet know whether the
 * relay finished playing before the visitor barged in. `noteRelayOutcome`
 * (fired by the realtime session's own completion signal) resolves the park;
 * an unresolved park times out after 30s and remains explicitly unconfirmed.
 */
export class VoiceContextProjector {
  #deps: VoiceContextProjectorDeps;
  #setTimer: (callback: () => void, delayMs: number) => VoiceTimerHandle;
  #clearTimer: (handle: VoiceTimerHandle) => void;
  #runs = new Map<string, RunState>();
  #parked = new Map<string, ParkedAnswer>();
  #latestSurface: Surface | null = null;

  constructor(deps: VoiceContextProjectorDeps) {
    this.#deps = deps;
    this.#setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  onEvent(runId: string, e: TurnEvent, requestText: string | null): void {
    const run = this.#runOrCreate(runId);
    run.requestText = requestText === null ? null : clamp(requestText, MAX_REQUEST_CHARS);
    switch (e.type) {
      case 'ui-rendered':
        if (this.#deps.screen.kind !== 'absent') {
          this.#onUiRendered(run, e.event);
        }
        return;
      case 'run-finished':
        this.#onRunFinished(runId, run, e.finalText);
        return;
      case 'answer-text':
      case 'tool-step':
      case 'run-failed':
        return;
    }
  }

  /**
   * Resolves the park for `runId` — the realtime session reports whether its
   * relay played to completion (`full`) or was interrupted (`partial`). A
   * call with no matching park (already resolved, already expired, or never
   * parked) is a no-op.
   */
  /**
   * Marks a run as one this attachment will never speak — the visitor started
   * it on their own screen and reads the answer there. Its result still becomes
   * common ground, because "what the visitor already saw" is exactly what voice
   * is allowed to know.
   */
  noteRunUnspoken(runId: string): void {
    this.#runOrCreate(runId).spoken = false;
  }

  /** Reverses `noteRunUnspoken` when a run's voice origin is discovered late. */
  noteRunSpoken(runId: string): void {
    this.#runOrCreate(runId).spoken = true;
  }

  noteRelayOutcome(runId: string, outcome: 'full' | 'partial' | 'unconfirmed'): void {
    const parked = this.#parked.get(runId);
    if (!parked) {
      return;
    }
    this.#parked.delete(runId);
    this.#clearTimer(parked.timer);
    if (outcome === 'full') {
      this.#deps.appendLedger(deliveredLine('spoken-full', parked.requestText, parked.answer));
      return;
    }
    if (outcome === 'partial') {
      this.#deps.appendLedger(
        deliveredLine('spoken-partial', parked.requestText, INTERRUPTED_DELIVERY),
      );
      return;
    }
    this.#deps.appendLedger(
      deliveredLine('delivery-unconfirmed', parked.requestText, UNCONFIRMED_DELIVERY),
    );
  }

  /**
   * Always states the screen, including its absence: an empty block leaves the
   * voice model with nothing to answer a "what's on screen?" question from,
   * which pushes it into forwarding — and a forwarded read can change the very
   * screen it asked about.
   */
  screenStateBlock(): string {
    if (this.#deps.screen.kind === 'absent') {
      return 'SCREEN ACCESS: unavailable on this attachment. Do not claim the user can see or use a screen.';
    }
    if (this.#deps.screen.kind === 'live') {
      const screen = this.#deps.screen.read();
      if (screen?.kind === 'structured' && screen.sections.length > 0) {
        const structure = projectScreen({
          sections: screen.sections,
          values: screen.values,
          fallbackText: screen.fallbackMarkdown
            ? this.#deps.stripMarkdown(screen.fallbackMarkdown)
            : undefined,
          isSensitive: screen.isSensitive ?? (() => false),
          maxChars: this.#deps.screenBudgetChars ?? DEFAULT_SCREEN_BUDGET_CHARS,
        });
        return `CURRENT SCREEN: ${structure}`;
      }
      if (screen?.kind === 'text') {
        const text = clampScreenText(
          this.#deps.stripMarkdown(screen.text),
          this.#deps.screenBudgetChars ?? DEFAULT_SCREEN_BUDGET_CHARS,
        );
        if (text) {
          return `CURRENT SCREEN: ${text}`;
        }
      }
      return 'CURRENT SCREEN: nothing is on the visitor’s screen yet.';
    }
    if (!this.#latestSurface) {
      return 'LATEST DELIVERED RESULT: none yet.';
    }
    return `LATEST DELIVERED RESULT: ${this.#latestSurface.component} — ${this.#latestSurface.summary}`;
  }

  /**
   * Clears every pending park timer when its owning attachment closes.
   */
  dispose(): void {
    for (const parked of this.#parked.values()) {
      this.#clearTimer(parked.timer);
    }
    this.#parked.clear();
  }

  #runOrCreate(runId: string): RunState {
    const existing = this.#runs.get(runId);
    if (existing) {
      return existing;
    }
    const created: RunState = { requestText: null, surface: null, spoken: true };
    this.#runs.set(runId, created);
    return created;
  }

  #onUiRendered(run: RunState, event: UIRenderedEvent): void {
    const raw = this.#deps.stripMarkdown(event.fallbackMarkdown ?? '');
    const summary = clamp(raw, MAX_SUMMARY_CHARS) || event.component;
    const surface: Surface = { component: event.component, summary };
    run.surface = surface;
    this.#latestSurface = surface;
  }

  #onRunFinished(runId: string, run: RunState, finalText: string): void {
    if (finalText) {
      if (run.spoken) {
        this.#park(runId, run.requestText, finalText);
        return;
      }
      this.#deps.appendLedger(deliveredLine('seen-on-screen', run.requestText, finalText));
      return;
    }
    if (!run.surface) {
      return;
    }
    this.#deps.appendLedger(
      deliveredLine('screen-only', run.requestText, `shown on screen: ${run.surface.summary}`),
    );
  }

  #park(runId: string, requestText: string | null, finalText: string): void {
    const existing = this.#parked.get(runId);
    if (existing) {
      this.#clearTimer(existing.timer);
    }
    const timer = this.#setTimer(() => this.#expirePark(runId), PARK_TIMEOUT_MS);
    this.#parked.set(runId, { requestText, answer: clamp(finalText, MAX_ANSWER_CHARS), timer });
  }

  #expirePark(runId: string): void {
    const parked = this.#parked.get(runId);
    if (!parked) {
      return;
    }
    this.#parked.delete(runId);
    this.#deps.appendLedger(
      deliveredLine('delivery-unconfirmed', parked.requestText, UNCONFIRMED_DELIVERY),
    );
  }
}
