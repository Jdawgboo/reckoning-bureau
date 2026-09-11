/**
 * ChannelHandler — processes channel messages from the inbox pipeline.
 *
 * Reads `/inbox/channels/{channelType}/{channelId}/msg-*.json` events,
 * runs the agent with session-based history, and writes replies to outbox.
 *
 * Source-agnostic: doesn't know how messages reached the inbox
 * (Composio, webhooks, custom HTTP, etc.).
 */

import type { StateTree } from '../state/state-tree.ts';
import type { SessionManager } from '../sessions/session-manager.ts';
import { SessionQueue } from '../sessions/session-queue.ts';
import type { AgentRunHandle } from '../kernel/run-handle.ts';
import { ContentType } from '../types/content.ts';
import { generateShortId } from '../types/id.ts';

/** Inbound channel message written to /inbox/channels/{type}/{id}/msg-*.json */
export interface ChannelMessage {
  channelType: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  text: string;
  sender: {
    id: string;
    name?: string;
    isBot?: boolean;
    agentId?: string;
  };
  replyAction?: {
    provider: string;
    action: string;
    params: Record<string, unknown>;
  };
  timestamp: string;
}

/** Outbound reply written to /outbox/channels/{type}/{id}/reply-*.json */
export interface ChannelReply {
  replyId: string;
  channelType: string;
  channelId: string;
  threadId?: string;
  text: string;
  inReplyTo: string;
  replyAction?: {
    provider: string;
    action: string;
    params: Record<string, unknown>;
  };
  status: 'pending' | 'sent' | 'failed';
  timestamp: string;
  error?: string;
}

/**
 * Function that runs the agent for a channel message.
 * Provided by the consumer (e.g., container.ts) to decouple from Agent/Factory details.
 */
export type ChannelAgentRunner = (params: {
  query: string;
  sessionId: string;
  sessionType: 'channel';
  sessionName: string;
  channelMessage: ChannelMessage;
}) => Promise<AgentRunHandle>;

export interface ChannelHandlerOptions {
  state: StateTree;
  sessionManager: SessionManager;
  runAgent: ChannelAgentRunner;
  /** Max queue depth per session. Defaults to 50. */
  maxQueueDepth?: number;
}

export class ChannelHandler {
  #state: StateTree;
  #sessionManager: SessionManager;
  #queue: SessionQueue;
  #runAgent: ChannelAgentRunner;

  constructor(options: ChannelHandlerOptions) {
    this.#state = options.state;
    this.#sessionManager = options.sessionManager;
    this.#queue = new SessionQueue({ maxQueueSize: options.maxQueueDepth ?? 50 });
    this.#runAgent = options.runAgent;
  }

  /**
   * Handle a channel message from the inbox.
   * Extracts sessionId from path, enqueues for per-session sequential processing.
   */
  async handle(path: string, data: Record<string, unknown>): Promise<void> {
    const message = this.#parseChannelMessage(path, data);
    if (!message) {
      console.warn('[ChannelHandler] Could not parse channel message', { path });
      return;
    }

    if (!message.text) {
      console.warn('[ChannelHandler] Received message with empty text', {
        path,
        messageId: message.messageId,
        channelType: message.channelType,
        channelId: message.channelId,
      });
    }

    const sessionId = this.#resolveSessionId(message);
    const sessionName = this.#buildSessionName(message);

    console.log('[ChannelHandler] Enqueuing channel message', {
      sessionId,
      messageId: message.messageId,
      channelType: message.channelType,
      channelId: message.channelId,
    });

    await this.#queue.enqueue(sessionId, async () => {
      await this.#processMessage(sessionId, sessionName, message, path);
    });
  }

  /** Number of active sessions with queued or in-progress work. */
  get activeSessionCount(): number {
    return this.#queue.activeSessions;
  }

  /**
   * Parse inbox data into a ChannelMessage.
   * Falls back to extracting channelType/channelId from the path.
   */
  #parseChannelMessage(path: string, data: Record<string, unknown>): ChannelMessage | null {
    // Path format: /inbox/channels/{channelType}/{channelId}/msg-{id}.json
    const match = path.match(/^\/inbox\/channels\/([^/]+)\/([^/]+)\/msg-/);
    if (!match) {
      return null;
    }

    const [, pathChannelType, pathChannelId] = match;

    const rawSender = data.sender as Record<string, unknown> | undefined;
    const sender: ChannelMessage['sender'] =
      rawSender && typeof rawSender.id === 'string'
        ? {
            id: rawSender.id,
            name: rawSender.name as string | undefined,
            isBot: rawSender.isBot as boolean | undefined,
            agentId: rawSender.agentId as string | undefined,
          }
        : { id: (rawSender?.id as string) || 'unknown' };

    const rawReply = data.replyAction as Record<string, unknown> | undefined;
    const replyAction: ChannelMessage['replyAction'] =
      rawReply && typeof rawReply.provider === 'string' && typeof rawReply.action === 'string'
        ? {
            provider: rawReply.provider,
            action: rawReply.action,
            params: (rawReply.params as Record<string, unknown>) ?? {},
          }
        : undefined;

    return {
      channelType: (data.channelType as string) || pathChannelType,
      channelId: (data.channelId as string) || pathChannelId,
      threadId: data.threadId as string | undefined,
      messageId: (data.messageId as string) || generateShortId(),
      text: (data.text as string) || '',
      sender,
      replyAction,
      timestamp: (data.timestamp as string) || new Date().toISOString(),
    };
  }

  /** Build a human-readable session name from channel context + first message. */
  #buildSessionName(message: ChannelMessage): string {
    const sender = message.sender.name || message.sender.id;
    const textPreview = message.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${sender}: ${textPreview}`;
  }

  /** Resolve session ID from channel message. */
  #resolveSessionId(message: ChannelMessage): string {
    // Thread-level sessions: {channelType}/{channelId} or {channelType}/{channelId}/{threadId}
    if (message.threadId) {
      return `${message.channelType}/${message.channelId}/${message.threadId}`;
    }
    return `${message.channelType}/${message.channelId}`;
  }

  /** Process a single channel message — runs agent, writes reply to outbox. */
  async #processMessage(
    sessionId: string,
    sessionName: string,
    message: ChannelMessage,
    inboxPath: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      console.log('[ChannelHandler] Processing message', {
        sessionId,
        messageId: message.messageId,
      });

      // Run the agent
      const handle = await this.#runAgent({
        query: message.text,
        sessionId,
        sessionType: 'channel',
        sessionName,
        channelMessage: message,
      });

      // Collect the response text from the stream
      let replyText = '';
      for await (const chunk of handle.stream) {
        if (chunk.type === ContentType.Text) {
          replyText += (chunk as { content?: string }).content ?? '';
        }
      }

      await handle.done;

      // Write reply to outbox if there's a response and a reply action
      if (replyText.trim()) {
        const reply: ChannelReply = {
          replyId: generateShortId(),
          channelType: message.channelType,
          channelId: message.channelId,
          threadId: message.threadId,
          text: replyText,
          inReplyTo: message.messageId,
          replyAction: message.replyAction,
          status: 'pending',
          timestamp: new Date().toISOString(),
        };

        const outboxPath = `/outbox/channels/${message.channelType}/${message.channelId}/reply-${reply.replyId}.json`;
        await this.#state.set(outboxPath, reply);

        console.log('[ChannelHandler] Reply written to outbox', {
          sessionId,
          replyId: reply.replyId,
          outboxPath,
        });
      }

      // Log activity
      const durationMs = Date.now() - startTime;
      await this.#sessionManager.logActivity(sessionId, {
        action: 'channel.message.processed',
        summary: `Processed message from ${message.sender.name || message.sender.id} in ${message.channelType}/${message.channelId}`,
        status: 'success',
        durationMs,
        data: {
          messageId: message.messageId,
          channelType: message.channelType,
          channelId: message.channelId,
          hasReply: replyText.trim().length > 0,
        },
        timestamp: new Date().toISOString(),
      });

      // Delete processed inbox entry
      await this.#state.delete(inboxPath);

      console.log('[ChannelHandler] Message processed', {
        sessionId,
        messageId: message.messageId,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[ChannelHandler] Failed to process message', {
        sessionId,
        messageId: message.messageId,
        error: errorMessage,
      });

      await this.#sessionManager
        .logActivity(sessionId, {
          action: 'channel.message.error',
          summary: `Failed to process message from ${message.sender.name || message.sender.id}: ${errorMessage}`,
          status: 'error',
          durationMs,
          error: errorMessage,
          data: {
            messageId: message.messageId,
            channelType: message.channelType,
            channelId: message.channelId,
          },
          timestamp: new Date().toISOString(),
        })
        .catch((logErr) => {
          console.error('[ChannelHandler] Failed to log activity:', logErr);
        });
    }
  }
}
