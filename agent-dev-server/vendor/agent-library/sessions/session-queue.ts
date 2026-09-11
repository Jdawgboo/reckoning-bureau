/**
 * SessionQueue — per-session sequential, cross-session parallel work queue.
 *
 * Within one session: work items process strictly in order.
 * Across sessions: different sessions process in parallel.
 */

import { logAgentError } from '../util/log-agent-error.ts';

export interface SessionQueueOptions {
  /** Maximum queued items per session before dropping oldest. Default: 50. */
  maxQueueSize?: number;
}

interface QueueItem {
  handler: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class SessionQueue {
  #queues = new Map<string, QueueItem[]>();
  #processing = new Set<string>();
  #maxQueueSize: number;

  constructor(options?: SessionQueueOptions) {
    this.#maxQueueSize = options?.maxQueueSize ?? 50;
  }

  /**
   * Enqueue work for a session. If the session is idle, work starts immediately.
   * If the session is already processing, work is queued and will run after
   * the current item completes.
   *
   * The returned promise resolves when the handler itself completes (not when it's enqueued).
   */
  enqueue(sessionId: string, handler: () => Promise<void>): Promise<void> {
    let queue = this.#queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.#queues.set(sessionId, queue);
    }

    return new Promise<void>((resolve, reject) => {
      if (queue.length >= this.#maxQueueSize) {
        console.warn(`[SessionQueue] Queue full for ${sessionId}, dropping oldest`);
        const dropped = queue.shift();
        dropped?.reject(new Error(`Dropped: queue full for session ${sessionId}`));
      }

      queue.push({ handler, resolve, reject });

      // If not already processing this session, start
      if (!this.#processing.has(sessionId)) {
        this.#processNext(sessionId);
      }
    });
  }

  /** Number of queued items for a session (excluding the one currently processing). */
  queueDepth(sessionId: string): number {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  /** Whether a session is currently processing work. */
  isProcessing(sessionId: string): boolean {
    return this.#processing.has(sessionId);
  }

  /** Total number of sessions with queued or in-progress work. */
  get activeSessions(): number {
    let count = 0;
    for (const [sessionId, queue] of this.#queues) {
      if (queue.length > 0 || this.#processing.has(sessionId)) {
        count++;
      }
    }
    return count;
  }

  async #processNext(sessionId: string): Promise<void> {
    const queue = this.#queues.get(sessionId);
    if (!queue || queue.length === 0) {
      this.#processing.delete(sessionId);
      this.#queues.delete(sessionId);
      return;
    }

    this.#processing.add(sessionId);
    const item = queue.shift();
    if (!item) {
      return;
    }

    try {
      await item.handler();
      item.resolve();
    } catch (error) {
      logAgentError(`[SessionQueue] Error processing ${sessionId}:`, error);
      item.reject(error);
    }

    // Process next in queue (recursive but async — no stack growth)
    await this.#processNext(sessionId);
  }
}
