import type { NovaBidirectionalStream } from '../nova-bedrock-stream.ts';

/**
 * In-process fake of the Nova Sonic bidirectional stream (same philosophy as
 * `ScriptedRealtimePeer`): records every frame the adapter sends **in the exact
 * wire shape**, lets a test script server frames, and can end or fail the
 * stream.
 *
 * `sent` holds `{ event: { … } }` objects rather than a convenience projection,
 * because the point of the double is to prove what Nova would have received.
 *
 * {@link emit}, {@link end} and {@link fail} are async and resolve once the
 * adapter's pump has consumed what they produced, so a test never has to guess
 * how many microtasks an assertion is waiting on.
 */
export class ScriptedNovaStream implements NovaBidirectionalStream {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  #queue: Record<string, unknown>[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #failure: Error | null = null;
  #pushed = 0;
  #delivered = 0;

  send(frame: Record<string, unknown>): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closed = true;
  }

  events(): AsyncIterable<Record<string, unknown>> {
    return this.#events();
  }

  /** Script one or more server frames, in wire shape, and wait for them to land. */
  async emit(...frames: Record<string, unknown>[]): Promise<void> {
    this.#pushed += frames.length;
    this.#queue.push(...frames);
    this.#release();
    await this.#settle();
  }

  /** End the stream normally — the provider hung up. */
  async end(): Promise<void> {
    this.#ended = true;
    this.#release();
    await this.#settle();
  }

  /** Fail the stream — a `ValidationException`, a timeout, a transport fault. */
  async fail(error: Error): Promise<void> {
    this.#failure = error;
    this.#release();
    await this.#settle();
  }

  /** Frames sent so far, flattened to `[name, body]` pairs in order. */
  frames(): Array<{ name: string; body: Record<string, unknown> }> {
    const out: Array<{ name: string; body: Record<string, unknown> }> = [];
    for (const frame of this.sent) {
      const event = frame.event;
      if (typeof event !== 'object' || event === null) {
        continue;
      }
      for (const [name, body] of Object.entries(event)) {
        out.push({
          name,
          body: typeof body === 'object' && body !== null ? { ...body } : {},
        });
      }
    }
    return out;
  }

  /** Names of the frames sent so far, in order. */
  frameNames(): string[] {
    return this.frames().map((frame) => frame.name);
  }

  async *#events(): AsyncIterable<Record<string, unknown>> {
    while (true) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        this.#delivered += 1;
        continue;
      }
      if (this.#failure) {
        const failure = this.#failure;
        this.#failure = null;
        this.#delivered = this.#pushed;
        throw failure;
      }
      if (this.#ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #release(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /**
   * Lets the pump drain. Bounded rather than unbounded so a test whose adapter
   * stopped consuming fails on its assertion instead of hanging.
   */
  async #settle(): Promise<void> {
    for (let tick = 0; tick < 50; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#delivered >= this.#pushed) {
        return;
      }
    }
  }
}
