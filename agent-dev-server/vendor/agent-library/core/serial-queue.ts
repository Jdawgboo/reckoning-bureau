/**
 * Runs async tasks one at a time, in submission order.
 *
 * `enqueue` returns void for fire-and-forget callers. `enqueueAndWait`
 * exposes that task's outcome to callers that need an acknowledgement.
 * Failures are forwarded to `onError` and never stall later tasks.
 */
export interface ISerialQueue {
  enqueue(task: () => Promise<void>): void;
  enqueueAndWait(task: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
}

export class SerialQueue implements ISerialQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = () => {}) {
    this.#onError = onError;
  }

  enqueue(task: () => Promise<void>): void {
    void this.#append(task).catch(() => {});
  }

  enqueueAndWait(task: () => Promise<void>): Promise<void> {
    return this.#append(task);
  }

  drain(): Promise<void> {
    return this.#tail;
  }

  #append(task: () => Promise<void>): Promise<void> {
    const outcome = this.#tail.then(() => task());
    this.#tail = outcome.catch((err) => void this.#onError(err));
    return outcome;
  }
}
