/**
 * Single-flight, cancelable resume loop with exponential backoff.
 */
export class ResumeController {
  #maxAttempts: number;
  #baseDelayMs: number;
  #attempt = 0;
  #cancelled = false;

  constructor(options: { maxAttempts?: number; baseDelayMs?: number } = {}) {
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#baseDelayMs = options.baseDelayMs ?? 1000;
  }

  cancel(): void {
    this.#cancelled = true;
  }

  async run(attempt: () => Promise<void>, onExhausted: () => void): Promise<void> {
    while (this.#attempt < this.#maxAttempts && !this.#cancelled) {
      this.#attempt++;
      const delay = Math.min(this.#baseDelayMs * 2 ** (this.#attempt - 1), 30_000);
      await new Promise<void>((r) => setTimeout(r, delay));
      if (this.#cancelled) return;
      try {
        await attempt();
        return;
      } catch {
        // continue retrying
      }
    }
    if (!this.#cancelled) onExhausted();
  }
}
