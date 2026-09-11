import { getAgentLogger } from '../types/logger.ts';
import type { CatchUpResult } from '../streaming/protocol.ts';
import type {
  IReplayBuffer,
  StartStreamOptions,
  StreamMetadata,
  StreamEventMessage,
  StreamTransport,
  CatchUpOptions,
} from './types.ts';

const EVENT_DELAY_MS = 4;

/**
 * Text a client sees when a stream terminated in an error that carried no usable
 * message. Producers that persist a stream's error text should reuse this
 * constant so the stored value and the replayed value cannot drift apart.
 */
export const STREAM_ERROR_FALLBACK_MESSAGE = 'Stream ended with error';

/**
 * Base class for replay buffer implementations.
 * Provides the catchUp() orchestration — subclasses only implement storage.
 */
export abstract class AbstractReplayBuffer implements IReplayBuffer {
  abstract startStream(streamId: string, options?: StartStreamOptions): Promise<void>;
  abstract captureEvent(streamId: string, content: unknown): Promise<number>;
  abstract endStream(streamId: string, error?: string, responseId?: string): Promise<void>;
  abstract finalizeStream(streamId: string): void;
  abstract getMetadata(streamId: string): Promise<StreamMetadata | null>;
  abstract getEvents(
    streamId: string,
    afterEventSeq?: number,
  ): Promise<{ events: unknown[]; lastEventSeq: number }>;
  abstract subscribe(
    streamId: string,
    onMessage: (message: StreamEventMessage) => void,
  ): Promise<() => void>;
  abstract isStreamAlive(streamId: string): Promise<boolean>;
  abstract shutdown(): Promise<void>;

  async catchUp(options: CatchUpOptions): Promise<CatchUpResult> {
    const { streamId, transport, afterEventSeq = 0, isLocallyActive } = options;

    let unsubscribe: (() => void) | null = null;

    try {
      const metadata = await this.getMetadata(streamId);
      if (!metadata) {
        return { type: 'error', error: 'Stream not found or expired', responseId: streamId };
      }

      // Buffer for live events that arrive between subscribe and XRANGE
      const buffer: StreamEventMessage[] = [];
      let forwardHandler: ((msg: StreamEventMessage) => void) | null = null;

      if (metadata.status === 'in_progress') {
        const locallyManaged = isLocallyActive?.(streamId) ?? false;
        if (!locallyManaged) {
          const isAlive = await this.isStreamAlive(streamId);
          if (!isAlive) {
            getAgentLogger().warn(`[CatchUp] Orphaned stream detected`, { streamId });
            return {
              type: 'error',
              error: 'Stream is no longer active (server may have restarted)',
              responseId: streamId,
            };
          }
        }

        // Subscribe BEFORE getEvents to close the event gap
        unsubscribe = await this.subscribe(streamId, (msg) => {
          if (forwardHandler) {
            forwardHandler(msg);
          } else {
            buffer.push(msg);
          }
        });
      }

      const { events, lastEventSeq: retrievedLastEventSeq } = await this.getEvents(
        streamId,
        afterEventSeq,
      );

      let lastSentEventSeq = afterEventSeq;
      if (retrievedLastEventSeq > lastSentEventSeq) {
        lastSentEventSeq = retrievedLastEventSeq;
      }

      getAgentLogger().info(`[CatchUp] Starting catch-up`, {
        streamId,
        clientAfterEventSeq: afterEventSeq,
        streamStatus: metadata.status,
        totalEventsInMetadata: metadata.totalEvents,
        eventsRetrieved: events.length,
      });

      // Fire-and-forget: paced replay → drain → forward → terminate
      let totalSent = 0;
      let isTerminated = false;

      const sendContent = (content: unknown): void => {
        const seq = (content as { eventSeq?: number }).eventSeq ?? 0;
        if (seq > lastSentEventSeq) {
          lastSentEventSeq = seq;
        }
        totalSent++;
        transport.sendEvent(content, seq);
      };

      let terminate = (status: string, error?: string): void => {
        if (isTerminated) return;
        isTerminated = true;
        unsubscribe?.();

        getAgentLogger().info(`[CatchUp] Replay complete`, { streamId, totalSent, status });

        if (status === 'completed' || status === 'end') {
          transport.sendEnd();
        } else if (status === 'error') {
          const trimmed = error?.trim();
          transport.sendError(trimmed ? trimmed : STREAM_ERROR_FALLBACK_MESSAGE);
        }
      };

      const processLiveMessage = (message: StreamEventMessage): void => {
        if (isTerminated) return;
        if (!transport.isOpen()) {
          terminate('completed');
          return;
        }

        if (message.type === 'event' && message.content) {
          const seq = (message.content as { eventSeq?: number }).eventSeq ?? 0;
          if (seq <= lastSentEventSeq) return;
          sendContent(message.content);
        } else if (message.type === 'end') {
          terminate('completed');
        } else if (message.type === 'error') {
          terminate('error', message.error);
        }
      };

      // Set up close handler
      transport.onClose(() => {
        if (!isTerminated) {
          isTerminated = true;
          unsubscribe?.();
        }
      });

      const sendPaced = (evts: unknown[]): Promise<void> => {
        if (afterEventSeq === 0) {
          for (const evt of evts) sendContent(evt);
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          let index = 0;
          const sendNext = () => {
            if (index < evts.length) {
              sendContent(evts[index++]);
              setTimeout(sendNext, EVENT_DELAY_MS);
            } else {
              resolve();
            }
          };
          sendNext();
        });
      };

      sendPaced(events).then(async () => {
        if (metadata.status !== 'in_progress' || !unsubscribe) {
          terminate(metadata.status, metadata.error);
          return;
        }

        // Set forwardHandler BEFORE draining — events arriving during the async
        // getMetadata re-read below must go to processLiveMessage, not back to buffer.
        forwardHandler = (msg) => processLiveMessage(msg);

        // Drain any events that pub/sub delivered while sendPaced was running.
        for (const msg of buffer.splice(0)) {
          processLiveMessage(msg);
          if (isTerminated) return;
        }

        // Re-read metadata: catches streams that completed before our subscription
        // so their 'end' pub/sub event was never buffered.
        try {
          const freshMeta = await this.getMetadata(streamId);
          if (!freshMeta || freshMeta.status !== 'in_progress') {
            terminate(freshMeta?.status ?? 'error', freshMeta?.error);
            return;
          }
        } catch (err) {
          getAgentLogger().warn('[CatchUp] Post-drain metadata re-read failed', {
            streamId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Watchdog: re-check metadata and liveness periodically.
        // Guards against a lost 'end' pub/sub event leaving the stream open forever.
        const WATCHDOG_INTERVAL_MS = 30_000;
        const watchdog = setInterval(async () => {
          if (isTerminated) {
            clearInterval(watchdog);
            return;
          }

          try {
            const meta = await this.getMetadata(streamId);
            if (!meta || meta.status !== 'in_progress') {
              clearInterval(watchdog);
              terminate(meta?.status ?? 'error', meta?.error);
              return;
            }

            const alive = await this.isStreamAlive(streamId);
            if (!alive) {
              clearInterval(watchdog);
              terminate('error', 'Stream is no longer active');
            }
          } catch (err) {
            getAgentLogger().warn('[CatchUp] Watchdog check failed', {
              streamId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, WATCHDOG_INTERVAL_MS);

        // Wrap terminate to clean up watchdog on any termination path
        const origTerminate = terminate;
        terminate = (status: string, error?: string) => {
          clearInterval(watchdog);
          origTerminate(status, error);
        };
        transport.onClose(() => clearInterval(watchdog));

        getAgentLogger().info(`[CatchUp] Switched to live forwarding for ${streamId}`, {
          totalSentAfterDrain: totalSent,
          lastSentEventSeq,
        });
      });

      return {
        type: 'resumed',
        responseId: streamId,
        lastEventSeq: lastSentEventSeq,
        status: metadata.status,
        totalEvents: metadata.totalEvents,
        replayedEvents: events.length,
      };
    } catch (error) {
      unsubscribe?.();
      throw error;
    }
  }
}
