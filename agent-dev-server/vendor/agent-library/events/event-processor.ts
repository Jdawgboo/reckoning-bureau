/**
 * EventProcessor — central event router for the inbox pipeline.
 *
 * Subscribes to `/inbox/**` via StateTree and routes events by path prefix:
 *   /inbox/triggers/** → TriggerDispatcher
 *   /inbox/channels/** → ChannelHandler  (Phase 4)
 *   /inbox/cron/**     → ScheduleHandler     (Phase 5)
 *   /inbox/agents/**   → AgentCommHandler (Phase 6)
 *
 * Deduplicates events by eventId to handle overlapping delivery paths
 * (live subscription + InboxReconciler on startup).
 */

import type { StateTree } from '../state/state-tree.ts';
import type { Unsubscribe } from '../state/types.ts';
import type { TriggerDispatcher } from './trigger-dispatcher.ts';
import type { ScheduleDispatcher } from './schedule-dispatcher.ts';
import type { ChannelHandler } from './channel-handler.ts';
import type { TriggerEvent } from './types.ts';
import type { ScheduleEvent } from './schedule-types.ts';
import type { SessionManager } from '../sessions/session-manager.ts';

export interface EventProcessorOptions {
  state: StateTree;
  triggerDispatcher: TriggerDispatcher;
  /** Optional ScheduleDispatcher for processing schedule events. */
  scheduleDispatcher?: ScheduleDispatcher;
  /** Optional ChannelHandler for processing channel messages (Phase 4b). */
  channelHandler?: ChannelHandler;
  /** Optional SessionManager for writing activity log entries. */
  sessionManager?: SessionManager;
}

export class EventProcessor {
  #state: StateTree;
  #triggerDispatcher: TriggerDispatcher;
  #scheduleDispatcher?: ScheduleDispatcher;
  #channelHandler?: ChannelHandler;
  #sessionManager?: SessionManager;
  #unsubscribe: Unsubscribe | null = null;
  /** Tracks processed event IDs with timestamps for TTL-based eviction. */
  #processedEvents = new Map<string, number>();
  /** TTL for dedup entries (15 minutes). Events older than this are evicted. */
  static readonly #DEDUP_TTL_MS = 15 * 60 * 1000;
  /** Eviction runs every N insertions to avoid per-insert overhead. */
  static readonly #EVICT_INTERVAL = 500;
  #inflight = new Set<Promise<void>>();
  #started = false;

  constructor(options: EventProcessorOptions) {
    this.#state = options.state;
    this.#triggerDispatcher = options.triggerDispatcher;
    this.#scheduleDispatcher = options.scheduleDispatcher;
    this.#channelHandler = options.channelHandler;
    this.#sessionManager = options.sessionManager;
  }

  /** Subscribe to inbox and start processing events. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    console.log('[EventProcessor] Starting — subscribing to /inbox/**');

    this.#unsubscribe = this.#state.subscribe('/inbox/**', (event) => {
      console.log('[EventProcessor] Subscription fired', {
        path: event.path,
        change: event.change,
        source: event.source,
        hasValue: event.value !== undefined,
      });
      if (event.change !== 'set' || event.value === undefined) {
        return;
      }
      this.#processEvent(event.path, event.value as Record<string, unknown>);
    });
  }

  /** Unsubscribe and stop processing. Awaits in-flight dispatches. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#started = false;
    if (this.#inflight.size > 0) {
      console.log(`[EventProcessor] Draining ${this.#inflight.size} in-flight dispatch(es)`);
      await Promise.allSettled(this.#inflight);
    }
    this.#processedEvents.clear();
  }

  /**
   * Process a single event. Used by both the live subscription and InboxReconciler.
   * Deduplicates by eventId.
   */
  processEvent(path: string, value: Record<string, unknown>): void {
    this.#processEvent(path, value);
  }

  /** Check if an event was already processed. */
  isProcessed(eventId: string): boolean {
    return this.#processedEvents.has(eventId);
  }

  /**
   * Canonical dedup key: the eventId if the producer provided one, else the
   * inbox path. Exported as a helper so the insert site and every retry
   * cleanup site compute the same string — mismatched keys silently leak
   * events or repeat them. All `#processedEvents.delete(...)` calls MUST
   * route through this function.
   */
  #dedupKeyFor(path: string, eventId: string | undefined): string {
    return eventId && eventId.length > 0 ? eventId : path;
  }

  #processEvent(path: string, eventData: Record<string, unknown>): void {
    const eventId = this.#dedupKeyFor(path, eventData.eventId as string | undefined);

    if (this.#processedEvents.has(eventId)) {
      console.log('[EventProcessor] Dedup — skipping already processed event', {
        eventId,
        path,
        processedCount: this.#processedEvents.size,
      });
      return;
    }
    const now = Date.now();
    this.#processedEvents.set(eventId, now);
    // Periodically evict entries older than the TTL
    if (this.#processedEvents.size % EventProcessor.#EVICT_INTERVAL === 0) {
      const cutoff = now - EventProcessor.#DEDUP_TTL_MS;
      for (const [key, ts] of this.#processedEvents) {
        if (ts < cutoff) {
          this.#processedEvents.delete(key);
        }
      }
    }
    console.log('[EventProcessor] Processing new event', {
      eventId,
      path,
      processedCount: this.#processedEvents.size,
    });

    // Route by path prefix
    if (path.startsWith('/inbox/triggers/')) {
      this.#handleTrigger(path, eventData);
    } else if (path.startsWith('/inbox/channels/')) {
      this.#handleChannel(path, eventData);
    } else if (path.startsWith('/inbox/cron/')) {
      this.#handleSchedule(path, eventData);
    }
    // Phase 6: else if (path.startsWith('/inbox/agents/'))
  }

  #handleChannel(path: string, eventData: Record<string, unknown>): void {
    if (!this.#channelHandler) {
      console.warn('[EventProcessor] Channel message received but no ChannelHandler configured', {
        path,
      });
      return;
    }

    console.log('[EventProcessor] Routing to ChannelHandler', { path });

    // ChannelHandler manages its own queue, dedup, and inbox deletion.
    // We just fire-and-forget here — errors are handled inside ChannelHandler.
    const p = this.#channelHandler
      .handle(path, eventData)
      .catch((err) => {
        console.error(`[EventProcessor] ChannelHandler failed for ${path}:`, err);
        // Remove from dedup set so InboxReconciler can retry.
        this.#processedEvents.delete(
          this.#dedupKeyFor(path, eventData.eventId as string | undefined),
        );
      })
      .finally(() => {
        this.#inflight.delete(p);
      });
    this.#inflight.add(p);
  }

  #handleTrigger(path: string, eventData: Record<string, unknown>): void {
    const triggerEvent: TriggerEvent = {
      eventId: (eventData.eventId as string) || '',
      triggerName: (eventData.triggerName as string) || '',
      provider: (eventData.provider as string) || '',
      payload: (eventData.payload as Record<string, unknown>) || {},
      timestamp: (eventData.timestamp as string) || new Date().toISOString(),
      triggerId: eventData.triggerId as string | undefined,
      connectedAccountId: eventData.connectedAccountId as string | undefined,
    };

    console.log('[EventProcessor] Dispatching trigger', {
      eventId: triggerEvent.eventId,
      triggerName: triggerEvent.triggerName,
      provider: triggerEvent.provider,
      path,
    });

    const startTime = Date.now();
    const p = this.#triggerDispatcher
      .dispatch(triggerEvent)
      .then(() => {
        const durationMs = Date.now() - startTime;
        console.log('[EventProcessor] Trigger dispatched, deleting inbox entry', {
          eventId: triggerEvent.eventId,
          path,
          durationMs,
        });

        this.#logTriggerActivity(triggerEvent, 'success', durationMs);
        return this.#state.delete(path);
      })
      .then(() => {
        console.log('[EventProcessor] Inbox entry deleted', {
          eventId: triggerEvent.eventId,
          path,
        });
      })
      .catch((err) => {
        const durationMs = Date.now() - startTime;
        console.error(`[EventProcessor] Failed to process trigger at ${path}:`, err);

        this.#logTriggerActivity(
          triggerEvent,
          'error',
          durationMs,
          err instanceof Error ? err.message : String(err),
        );
        // Remove from dedup set so InboxReconciler can retry on next boot
        this.#processedEvents.delete(this.#dedupKeyFor(path, triggerEvent.eventId));
      })
      .finally(() => {
        this.#inflight.delete(p);
      });
    this.#inflight.add(p);
  }

  /**
   * Write an activity log entry for a trigger dispatch.
   * Resolves sessionId from the trigger's registration options.
   * Fire-and-forget — errors are logged but do not affect event processing.
   */
  #logTriggerActivity(
    event: TriggerEvent,
    status: 'success' | 'error',
    durationMs: number,
    error?: string,
  ): void {
    if (!this.#sessionManager) {
      return;
    }

    // Resolve sessionId from registration options
    const registration = this.#triggerDispatcher.getRegistration(event.triggerName);
    const sessionId = registration?.options?.sessionId?.(event);
    if (!sessionId) {
      return;
    }

    const action = status === 'success' ? 'trigger.processed' : 'trigger.error';
    const summary =
      status === 'success'
        ? `Processed ${event.triggerName} from ${event.provider}`
        : `Failed to process ${event.triggerName}: ${error}`;

    this.#sessionManager
      .logActivity(sessionId, {
        action,
        summary,
        status,
        durationMs,
        error,
        data: { eventId: event.eventId, triggerName: event.triggerName, provider: event.provider },
        timestamp: new Date().toISOString(),
      })
      .catch((err) => {
        console.error('[EventProcessor] Failed to log trigger activity:', err);
      });
  }

  #handleSchedule(path: string, eventData: Record<string, unknown>): void {
    if (!this.#scheduleDispatcher) {
      console.warn(
        '[EventProcessor] Schedule event received but no ScheduleDispatcher configured',
        {
          path,
        },
      );
      return;
    }

    const scheduleEvent: ScheduleEvent = {
      eventId: (eventData.eventId as string) || '',
      taskId: (eventData.taskId as string) || '',
      handler: (eventData.handler as string) || '',
      params: (eventData.params as Record<string, unknown>) || {},
      scheduledAt: (eventData.scheduledAt as string) || new Date().toISOString(),
      sessionId: eventData.sessionId as string | undefined,
      replyTo: eventData.replyTo as ScheduleEvent['replyTo'],
      delayedByHours: eventData.delayedByHours as number | undefined,
    };

    console.log('[EventProcessor] Dispatching schedule', {
      eventId: scheduleEvent.eventId,
      handler: scheduleEvent.handler,
      taskId: scheduleEvent.taskId,
      path,
    });

    const startTime = Date.now();
    const p = this.#scheduleDispatcher
      .dispatch(scheduleEvent)
      .then(() => {
        const durationMs = Date.now() - startTime;
        console.log('[EventProcessor] Schedule dispatched, deleting inbox entry', {
          eventId: scheduleEvent.eventId,
          path,
          durationMs,
        });
        this.#logScheduleActivity(scheduleEvent, 'success', durationMs);
        return this.#state.delete(path);
      })
      .then(() => {
        console.log('[EventProcessor] Schedule inbox entry deleted', {
          eventId: scheduleEvent.eventId,
          path,
        });
      })
      .catch((err) => {
        const durationMs = Date.now() - startTime;
        console.error(`[EventProcessor] Failed to process schedule at ${path}:`, err);
        this.#logScheduleActivity(
          scheduleEvent,
          'error',
          durationMs,
          err instanceof Error ? err.message : String(err),
        );
        // Remove from dedup set so InboxReconciler can retry on next boot
        this.#processedEvents.delete(this.#dedupKeyFor(path, scheduleEvent.eventId));
      })
      .finally(() => {
        this.#inflight.delete(p);
      });
    this.#inflight.add(p);
  }

  /**
   * Write an activity log entry for a schedule dispatch.
   * Resolves sessionId from the schedule event or registration options.
   * Fire-and-forget — errors are logged but do not affect event processing.
   */
  #logScheduleActivity(
    event: ScheduleEvent,
    status: 'success' | 'error',
    durationMs: number,
    error?: string,
  ): void {
    if (!this.#sessionManager) {
      return;
    }

    // Resolve sessionId from registration options or event
    const registration = this.#scheduleDispatcher?.getRegistration(event.handler);
    const sessionId = registration?.options?.sessionId?.(event) ?? event.sessionId;
    if (!sessionId) {
      return;
    }

    const action = status === 'success' ? 'schedule.processed' : 'schedule.error';
    const summary =
      status === 'success'
        ? `Processed schedule ${event.handler} (task: ${event.taskId})`
        : `Failed to process schedule ${event.handler}: ${error}`;

    this.#sessionManager
      .logActivity(sessionId, {
        action,
        summary,
        status,
        durationMs,
        error,
        data: {
          eventId: event.eventId,
          taskId: event.taskId,
          handler: event.handler,
          delayedByHours: event.delayedByHours,
        },
        timestamp: new Date().toISOString(),
      })
      .catch((err) => {
        console.error('[EventProcessor] Failed to log schedule activity:', err);
      });
  }
}
