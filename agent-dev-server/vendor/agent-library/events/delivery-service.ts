/**
 * DeliveryService — delivers outbox items to external platforms.
 *
 * Subscribes to `/outbox/**` via StateTree. When a new item with
 * `status: 'pending'` appears, delivers it via the registered
 * OutboundChannelAdapter. Updates status to 'sent' or 'failed'.
 *
 * Retry with exponential backoff on transient failures.
 * Startup reconciliation scans outbox for unsent items.
 */

import type { StateTree } from '../state/state-tree.ts';
import type { Unsubscribe } from '../state/types.ts';
import type { ChannelReply } from './channel-handler.ts';

/** Result of delivering a reply to a platform. */
export interface DeliveryResult {
  status: 'sent' | 'failed';
  /** Platform-specific message ID of the sent reply. */
  platformMessageId?: string;
  error?: string;
}

/** Outbound adapter for delivering replies to a specific platform. */
export interface OutboundChannelAdapter {
  /** Platform identifier (e.g., 'slack', 'discord', 'telegram'). */
  readonly channelType: string;

  /** Deliver a reply to the platform. */
  deliver(reply: ChannelReply): Promise<DeliveryResult>;
}

export interface DeliveryServiceOptions {
  state: StateTree;
  /** Pre-registered adapters. More can be added via registerAdapter(). */
  adapters?: OutboundChannelAdapter[];
  /** Max delivery attempts per item. Defaults to 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Defaults to 1000. */
  baseDelayMs?: number;
  /** Max delay cap for backoff (ms). Defaults to 30000. */
  maxDelayMs?: number;
}

export class DeliveryService {
  #state: StateTree;
  #adapters = new Map<string, OutboundChannelAdapter>();
  #unsubscribe: Unsubscribe | null = null;
  #inflight = new Set<Promise<void>>();
  #started = false;
  #maxRetries: number;
  #baseDelayMs: number;
  #maxDelayMs: number;
  /** Tracks retry attempts per outbox path (in-memory, resets on restart). */
  #retryAttempts = new Map<string, number>();
  /** Active retry timers for cleanup on stop. */
  #retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Paths currently being delivered (prevents duplicate delivery). */
  #delivering = new Set<string>();
  /** Paths with a pending retry timer (prevents premature #delivering removal). */
  #retryPending = new Set<string>();

  constructor(options: DeliveryServiceOptions) {
    this.#state = options.state;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;

    if (options.adapters) {
      for (const adapter of options.adapters) {
        this.#adapters.set(adapter.channelType, adapter);
      }
    }
  }

  /** Register an outbound adapter for a channel type. */
  registerAdapter(adapter: OutboundChannelAdapter): void {
    this.#adapters.set(adapter.channelType, adapter);
  }

  /** Number of registered adapters. */
  get adapterCount(): number {
    return this.#adapters.size;
  }

  /** Subscribe to outbox and start delivering. Also runs reconciliation. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    console.log('[DeliveryService] Starting — subscribing to /outbox/**');

    this.#unsubscribe = this.#state.subscribe('/outbox/**', (event) => {
      if (event.change !== 'set' || event.value === undefined) {
        return;
      }
      this.#handleOutboxItem(event.path, event.value as Record<string, unknown>);
    });

    // Reconcile on startup — process any pending items left from before
    this.reconcile().catch((err) => {
      console.error('[DeliveryService] Reconciliation failed:', err);
    });
  }

  /** Stop delivering. Cancels retries, drains in-flight deliveries. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#started = false;

    // Cancel pending retries
    for (const timer of this.#retryTimers) {
      clearTimeout(timer);
    }
    this.#retryTimers.clear();
    this.#retryAttempts.clear();
    this.#delivering.clear();
    this.#retryPending.clear();

    // Drain in-flight deliveries
    if (this.#inflight.size > 0) {
      console.log(`[DeliveryService] Draining ${this.#inflight.size} in-flight delivery(ies)`);
      await Promise.allSettled(this.#inflight);
    }
  }

  /**
   * Scan outbox for pending items and deliver them.
   * Called on startup and can be called manually.
   */
  async reconcile(): Promise<void> {
    console.log('[DeliveryService] Reconciling outbox...');

    const keys = await this.#state.list('/outbox/');
    let pending = 0;

    for (const key of keys) {
      const data = await this.#state.get<Record<string, unknown>>(key);
      if (data && data.status === 'pending') {
        pending++;
        this.#handleOutboxItem(key, data);
      }
    }

    console.log(`[DeliveryService] Reconciliation complete: ${pending} pending item(s) found`);
  }

  /** Handle a new or existing outbox item. */
  #handleOutboxItem(path: string, data: Record<string, unknown>): void {
    // Only process channel replies for now
    if (!path.startsWith('/outbox/channels/')) {
      return;
    }

    // Only deliver pending items
    if (data.status !== 'pending') {
      return;
    }

    // Prevent duplicate delivery of the same item
    if (this.#delivering.has(path)) {
      return;
    }

    const reply = data as unknown as ChannelReply;

    // Check for adapter
    const adapter = this.#adapters.get(reply.channelType);
    if (!adapter) {
      console.warn('[DeliveryService] No adapter registered for channel type', {
        channelType: reply.channelType,
        replyId: reply.replyId,
        path,
      });
      return;
    }

    console.log('[DeliveryService] Delivering reply', {
      replyId: reply.replyId,
      channelType: reply.channelType,
      channelId: reply.channelId,
      path,
    });

    this.#delivering.add(path);
    const p = this.#deliver(path, reply, adapter).finally(() => {
      this.#inflight.delete(p);
      // Only remove from #delivering if no retry is pending for this path.
      // If a retry was scheduled, #handleFailure re-adds the path before the timer fires.
      if (!this.#hasRetryPending(path)) {
        this.#delivering.delete(path);
      }
    });
    this.#inflight.add(p);
  }

  /** Attempt delivery. Updates outbox status on success/failure. */
  async #deliver(
    path: string,
    reply: ChannelReply,
    adapter: OutboundChannelAdapter,
  ): Promise<void> {
    try {
      const result = await adapter.deliver(reply);

      if (result.status === 'sent') {
        await this.#state.set(path, {
          ...reply,
          status: 'sent' as const,
          platformMessageId: result.platformMessageId,
          deliveredAt: new Date().toISOString(),
        });
        this.#retryAttempts.delete(path);

        console.log('[DeliveryService] Reply delivered', {
          replyId: reply.replyId,
          channelType: reply.channelType,
          platformMessageId: result.platformMessageId,
        });
      } else {
        // Adapter returned 'failed' explicitly
        await this.#handleFailure(path, reply, adapter, result.error || 'Delivery failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.#handleFailure(path, reply, adapter, errorMessage);
    }
  }

  /** Handle delivery failure — retry or mark as permanently failed. */
  async #handleFailure(
    path: string,
    reply: ChannelReply,
    adapter: OutboundChannelAdapter,
    error: string,
  ): Promise<void> {
    const attempts = (this.#retryAttempts.get(path) ?? 0) + 1;
    this.#retryAttempts.set(path, attempts);

    if (attempts < this.#maxRetries) {
      // Schedule retry with exponential backoff
      const delay = Math.min(this.#baseDelayMs * 2 ** (attempts - 1), this.#maxDelayMs);

      console.log('[DeliveryService] Scheduling retry', {
        replyId: reply.replyId,
        attempt: attempts,
        maxRetries: this.#maxRetries,
        delayMs: delay,
        error,
      });

      this.#retryPending.add(path);
      const timer = setTimeout(() => {
        this.#retryTimers.delete(timer);
        this.#retryPending.delete(path);
        if (this.#started) {
          this.#delivering.add(path);
          const p = this.#deliver(path, reply, adapter).finally(() => {
            this.#inflight.delete(p);
            if (!this.#hasRetryPending(path)) {
              this.#delivering.delete(path);
            }
          });
          this.#inflight.add(p);
        } else {
          this.#delivering.delete(path);
        }
      }, delay);
      this.#retryTimers.add(timer);
    } else {
      // Max retries exceeded — mark as failed
      console.error('[DeliveryService] Delivery failed after max retries', {
        replyId: reply.replyId,
        channelType: reply.channelType,
        attempts,
        error,
      });

      await this.#state.set(path, {
        ...reply,
        status: 'failed' as const,
        error,
        failedAt: new Date().toISOString(),
      });
      this.#retryAttempts.delete(path);
    }
  }

  #hasRetryPending(path: string): boolean {
    return this.#retryPending.has(path);
  }
}
