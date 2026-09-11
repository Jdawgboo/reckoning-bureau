import { ResumeController } from './resume-controller.ts';

export type StreamState = 'idle' | 'streaming' | 'paused' | 'resuming';

export interface AgentStreamSessionOptions {
  /**
   * Called on each resume attempt.
   * Return 'streaming' if the stream is still active after resume.
   * Return 'complete' if the stream finished while disconnected.
   * Throw to signal failure (the loop will retry).
   */
  onResume: () => Promise<'streaming' | 'complete'>;
  /** Called after all retry attempts are exhausted. */
  onExhausted: (error: Error) => void;
  onStateChange?: (state: StreamState) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Manages the 4-state streaming lifecycle: idle → streaming ↔ paused ↔ resuming.
 *
 * Owner (BuilderStreamSession, MessagesStore) calls:
 *   - streamStarted()  after the stream begins
 *   - disconnected()   when WS drops; triggers retry loop via onResume
 *   - reset()          when stream ends normally
 *   - abort()          to cancel and clean up
 */
export class AgentStreamSession {
  #state: StreamState = 'idle';
  #options: AgentStreamSessionOptions;
  #currentResume: ResumeController | null = null;

  constructor(options: AgentStreamSessionOptions) {
    this.#options = options;
  }

  get state(): StreamState {
    return this.#state;
  }

  /** Transition idle → streaming. Call after stream successfully starts. */
  streamStarted(): void {
    if (this.#state !== 'idle') return;
    this.#setState('streaming');
  }

  /**
   * Transition streaming/resuming → paused and start the retry loop.
   * Also re-triggers the loop when called from paused (manual resume support).
   */
  disconnected(): void {
    if (this.#state !== 'streaming' && this.#state !== 'resuming' && this.#state !== 'paused')
      return;
    this.#currentResume?.cancel();
    if (this.#state !== 'paused') {
      this.#setState('paused');
    }
    const resume = new ResumeController({
      maxAttempts: this.#options.maxAttempts,
      baseDelayMs: this.#options.baseDelayMs,
    });
    this.#currentResume = resume;
    const onAttempt = this.#makeAttemptCallback(resume);
    const onExhausted = this.#makeExhaustedCallback(resume);
    void resume.run(onAttempt, onExhausted).finally(() => {
      if (this.#currentResume === resume) {
        this.#currentResume = null;
      }
    });
  }

  /** Reset to idle. Cancels any ongoing retry. Call when stream ends normally. */
  reset(): void {
    this.#currentResume?.cancel();
    this.#currentResume = null;
    this.#setState('idle');
  }

  /** Abort retry loop and reset to idle. */
  abort(): void {
    this.#currentResume?.cancel();
    this.#currentResume = null;
    this.#setState('idle');
  }

  cleanup(): void {
    this.abort();
  }

  #makeAttemptCallback(resume: ResumeController): () => Promise<void> {
    return async () => {
      if (resume !== this.#currentResume) return;
      if (this.#state !== 'paused') return;
      this.#setState('resuming');
      let outcome: 'streaming' | 'complete';
      try {
        outcome = await this.#options.onResume();
      } catch (err) {
        if (resume === this.#currentResume && this.state === 'resuming') {
          this.#setState('paused');
        }
        throw err;
      }
      if (resume !== this.#currentResume) return;
      if (outcome === 'complete') {
        resume.cancel();
        this.#currentResume = null;
        this.#setState('idle');
      } else {
        this.#setState('streaming');
      }
    };
  }

  #makeExhaustedCallback(resume: ResumeController): () => void {
    return () => {
      if (resume !== this.#currentResume) return;
      this.#currentResume = null;
      this.#options.onExhausted(new Error('Failed to reconnect after retries'));
      this.#setState('idle');
    };
  }

  #setState(next: StreamState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#options.onStateChange?.(next);
  }
}
