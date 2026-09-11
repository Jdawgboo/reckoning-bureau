import { getVoiceLogger } from './util/logger.ts';

const logger = getVoiceLogger();

export type AdmissionSpeechIntent =
  | { kind: 'admission'; status: 'started'; runId: string }
  | { kind: 'admission'; status: 'queued'; runId: string }
  | { kind: 'admission'; status: 'busy' | 'failed'; reason?: string };

export type SpeechIntent =
  | AdmissionSpeechIntent
  | {
      kind: 'progress';
      fact: string;
      coalesceKey?: string;
      runId: string;
    }
  | {
      kind: 'relay';
      note: string;
      coalesceKey?: string;
      runId?: string;
    }
  | { kind: 'greeting'; runId?: never }
  | { kind: 'liveness'; runId: string };

export interface ActiveRunSilencePolicy {
  readonly initialSilenceMs: number;
  readonly maximumSilenceMs: number;
}

/**
 * Calibrated 2026-08-24 from live deep-research sessions: at 8s/24s the voice
 * produced ~10 lines in two minutes — every producer fact resets the clock to
 * the initial value, so short initial silence keeps the whole run chatty. The
 * listener needs presence, not narration: first check-in mid-run after 15s,
 * stretching to 45s between liveness lines while work continues.
 */
export const BROWSER_ACTIVE_RUN_SILENCE_POLICY: ActiveRunSilencePolicy = {
  initialSilenceMs: 15_000,
  maximumSilenceMs: 45_000,
};

export type SpeechDeliveryOutcome = 'full' | 'partial' | 'unconfirmed';

export interface SpeechSchedulerDeps {
  speak: (intent: SpeechIntent) => void;
  activeRunSilence: ActiveRunSilencePolicy;
  onLivenessFailure?: (reason: string) => void;
  now?: () => number;
}

interface OutstandingRun {
  suspended: boolean;
}

/** Serializes tool-disabled speech and owns one delivery-aware silence clock per attachment. */
export class SpeechScheduler {
  #deps: SpeechSchedulerDeps;
  #now: () => number;
  #responseActive = false;
  #deliveryPending = false;
  #activeIntent: SpeechIntent | null = null;
  #queue: SpeechIntent[] = [];
  #lastSpokenEndedAt: number;
  #outstandingRuns = new Map<string, OutstandingRun>();
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #nextSilenceMs: number;
  #livenessDisabled = false;
  #disposed = false;

  constructor(deps: SpeechSchedulerDeps) {
    assertSilencePolicy(deps.activeRunSilence);
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#lastSpokenEndedAt = this.#now();
    this.#nextSilenceMs = deps.activeRunSilence.initialSilenceMs;
  }

  schedule(intent: SpeechIntent): void {
    if (this.#disposed) {
      return;
    }
    if (intent.kind === 'relay') {
      this.#dropTransientSpeechForRun(intent.runId);
      this.#enqueueRelay(intent);
    } else if (intent.kind === 'progress') {
      this.#dropTransientSpeechForRun(intent.runId);
      this.#enqueueProgress(intent);
    } else if (intent.kind === 'admission') {
      if ('runId' in intent && this.#hasRelayForRun(intent.runId)) {
        return;
      }
      this.#enqueueAdmission(intent);
    } else {
      this.#queue.push(intent);
    }
    logger.debug('[Voice] intent scheduled', { kind: intent.kind, runId: runIdOf(intent) });
    this.#maybeFire();
  }

  noteRunOutstanding(runId: string): void {
    if (this.#disposed || !runId || this.#outstandingRuns.has(runId)) {
      return;
    }
    const hadEligibleRun = this.hasEligibleOutstandingRun();
    this.#outstandingRuns.set(runId, { suspended: false });
    if (!hadEligibleRun) {
      this.#nextSilenceMs = this.#deps.activeRunSilence.initialSilenceMs;
      this.#armSilenceTimer();
    }
  }

  noteRunTerminal(runId: string): void {
    if (!this.#outstandingRuns.delete(runId)) {
      return;
    }
    const removedLiveness = this.#queue.some(
      (intent) => intent.kind === 'liveness' && intent.runId === runId,
    );
    this.#queue = this.#queue.filter(
      (intent) => intent.kind !== 'liveness' || intent.runId !== runId,
    );
    if (!this.hasEligibleOutstandingRun()) {
      this.#clearSilenceTimer();
      return;
    }
    if (removedLiveness) {
      this.#deferDueLiveness();
    }
  }

  setRunLivenessSuspended(runId: string, suspended: boolean): void {
    const run = this.#outstandingRuns.get(runId);
    if (!run || run.suspended === suspended) {
      return;
    }
    const hadEligibleRun = this.hasEligibleOutstandingRun();
    run.suspended = suspended;
    let removedLiveness = false;
    if (suspended) {
      removedLiveness = this.#queue.some(
        (intent) => intent.kind === 'liveness' && intent.runId === runId,
      );
      this.#queue = this.#queue.filter(
        (intent) => intent.kind !== 'liveness' || intent.runId !== runId,
      );
    }
    if (!this.hasEligibleOutstandingRun()) {
      this.#clearSilenceTimer();
      return;
    }
    if (removedLiveness) {
      this.#deferDueLiveness();
      return;
    }
    if (!hadEligibleRun) {
      this.#nextSilenceMs = this.#deps.activeRunSilence.initialSilenceMs;
      this.#armSilenceTimer();
    }
  }

  hasEligibleOutstandingRun(): boolean {
    return [...this.#outstandingRuns.values()].some((run) => !run.suspended);
  }

  onResponseStarted(): void {
    this.#responseActive = true;
  }

  onUserResponseStarted(): void {
    this.#responseActive = true;
    this.#deliveryPending = false;
    this.#activeIntent = null;
  }

  onResponseDone(options?: { deliveryPending?: boolean }): void {
    this.#responseActive = false;
    this.#activeIntent = null;
    this.#deliveryPending = options?.deliveryPending === true;
    this.#maybeFire();
  }

  onSpeechDelivered(
    kind: SpeechIntent['kind'] | 'user-turn',
    outcome: SpeechDeliveryOutcome,
  ): void {
    this.#deliveryPending = false;
    if (outcome === 'unconfirmed') {
      this.#disableLiveness('listener delivery was not confirmed', false);
      this.#maybeFire();
      return;
    }
    this.#queue = this.#queue.filter((intent) => intent.kind !== 'liveness');
    this.#lastSpokenEndedAt = this.#now();
    if (outcome === 'partial') {
      this.#clearSilenceTimer();
      this.#maybeFire();
      return;
    }
    this.#nextSilenceMs =
      kind === 'liveness'
        ? Math.min(this.#nextSilenceMs * 2, this.#deps.activeRunSilence.maximumSilenceMs)
        : this.#deps.activeRunSilence.initialSilenceMs;
    this.#armSilenceTimer();
    this.#maybeFire();
  }

  onLivenessResponseWithoutDelivery(): void {
    this.#deliveryPending = false;
    this.#disableLiveness('liveness response produced no audible delivery', true);
    this.#maybeFire();
  }

  requeue(intent: SpeechIntent): void {
    if (this.#disposed) {
      return;
    }
    this.#responseActive = true;
    this.#deliveryPending = false;
    this.#activeIntent = null;
    this.#queue.unshift(intent);
  }

  evictQueued(kind: SpeechIntent['kind']): void {
    this.#queue = this.#queue.filter((intent) => intent.kind !== kind);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearSilenceTimer();
    this.#queue = [];
    this.#outstandingRuns.clear();
  }

  msSinceLastSpoken(): number {
    return this.#now() - this.#lastSpokenEndedAt;
  }

  #enqueueRelay(intent: Extract<SpeechIntent, { kind: 'relay' }>): void {
    if (intent.coalesceKey) {
      const existing = this.#queue.findIndex(
        (queued) => queued.kind === 'relay' && queued.coalesceKey === intent.coalesceKey,
      );
      if (existing >= 0) {
        this.#queue[existing] = intent;
        return;
      }
    }
    const livenessIndex = this.#queue.findIndex((queued) => queued.kind === 'liveness');
    if (livenessIndex < 0) {
      this.#queue.push(intent);
      return;
    }
    this.#queue.splice(livenessIndex, 0, intent);
  }

  #enqueueProgress(intent: Extract<SpeechIntent, { kind: 'progress' }>): void {
    const existing = this.#queue.findIndex(
      (queued) => queued.kind === 'progress' && queued.runId === intent.runId,
    );
    if (existing >= 0) {
      this.#queue[existing] = intent;
      return;
    }
    const livenessIndex = this.#queue.findIndex((queued) => queued.kind === 'liveness');
    if (livenessIndex < 0) {
      this.#queue.push(intent);
      return;
    }
    this.#queue.splice(livenessIndex, 0, intent);
  }

  #enqueueAdmission(intent: AdmissionSpeechIntent): void {
    const runId = runIdOf(intent);
    if (runId) {
      const existing = this.#queue.findIndex(
        (queued) => queued.kind === 'admission' && runIdOf(queued) === runId,
      );
      if (existing >= 0) {
        this.#queue[existing] = intent;
        return;
      }
    }
    this.#queue.push(intent);
  }

  #dropTransientSpeechForRun(runId: string | undefined): void {
    if (!runId) {
      return;
    }
    this.#queue = this.#queue.filter(
      (intent) =>
        !(
          (intent.kind === 'admission' ||
            intent.kind === 'progress' ||
            intent.kind === 'liveness') &&
          runIdOf(intent) === runId
        ),
    );
  }

  #hasRelayForRun(runId: string): boolean {
    return this.#queue.some((intent) => intent.kind === 'relay' && intent.runId === runId);
  }

  #armSilenceTimer(): void {
    this.#clearSilenceTimer();
    if (
      this.#disposed ||
      this.#livenessDisabled ||
      !this.hasEligibleOutstandingRun() ||
      this.#hasPendingLiveness()
    ) {
      return;
    }
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      this.#enqueueLiveness();
    }, this.#nextSilenceMs);
    this.#silenceTimer.unref?.();
  }

  #clearSilenceTimer(): void {
    if (!this.#silenceTimer) {
      return;
    }
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = null;
  }

  #enqueueLiveness(): void {
    if (this.#disposed || this.#livenessDisabled || this.#hasPendingLiveness()) {
      return;
    }
    const runId = this.#firstEligibleRunId();
    if (!runId) {
      return;
    }
    this.#queue.push({ kind: 'liveness', runId });
    logger.debug('[Voice] liveness became due', { runId });
    this.#maybeFire();
  }

  #deferDueLiveness(): void {
    this.#clearSilenceTimer();
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      this.#enqueueLiveness();
    }, 0);
    this.#silenceTimer.unref?.();
  }

  #firstEligibleRunId(): string | undefined {
    for (const [runId, run] of this.#outstandingRuns) {
      if (!run.suspended) {
        return runId;
      }
    }
    return undefined;
  }

  #hasPendingLiveness(): boolean {
    return (
      this.#activeIntent?.kind === 'liveness' ||
      this.#queue.some((intent) => intent.kind === 'liveness')
    );
  }

  #disableLiveness(reason: string, report: boolean): void {
    if (this.#livenessDisabled) {
      return;
    }
    this.#livenessDisabled = true;
    this.#clearSilenceTimer();
    this.#queue = this.#queue.filter((intent) => intent.kind !== 'liveness');
    if (report) {
      this.#deps.onLivenessFailure?.(reason);
    }
  }

  #maybeFire(): void {
    if (this.#disposed || this.#responseActive || this.#deliveryPending) {
      return;
    }
    let intent = this.#queue.shift();
    while (
      intent?.kind === 'liveness' &&
      (this.#livenessDisabled ||
        !this.#outstandingRuns.get(intent.runId) ||
        this.#outstandingRuns.get(intent.runId)?.suspended)
    ) {
      intent = this.#queue.shift();
    }
    if (!intent) {
      return;
    }
    this.#responseActive = true;
    this.#activeIntent = intent;
    this.#deps.speak(intent);
  }
}

function runIdOf(intent: SpeechIntent): string | undefined {
  return 'runId' in intent && typeof intent.runId === 'string' ? intent.runId : undefined;
}

function assertSilencePolicy(policy: ActiveRunSilencePolicy): void {
  if (
    !Number.isFinite(policy.initialSilenceMs) ||
    !Number.isFinite(policy.maximumSilenceMs) ||
    policy.initialSilenceMs <= 0 ||
    policy.maximumSilenceMs < policy.initialSilenceMs
  ) {
    throw new Error(
      'active run silence policy requires positive values and maximumSilenceMs >= initialSilenceMs',
    );
  }
}
