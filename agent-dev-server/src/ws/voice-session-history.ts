import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { VoiceHistoryBatch } from '../../vendor/agentplace-voice/voice-history-log.ts';
import type { AgentContentEvent } from '../../vendor/agent-library/sessions/produced-content.ts';
import type { AgentMessages } from '../../vendor/agent-library/sessions/produced-messages.ts';
import { userMessageIdFor } from '../../vendor/agent-library/sessions/user-message-id.ts';
import { createTextContent, type AgentContent } from '../bl/agent/agent-library.ts';

const INTERRUPTED_VOICE_MESSAGE = '[The voice response was interrupted before completion.]';
const UNAVAILABLE_TRANSCRIPT_MESSAGE = '[A spoken user turn could not be transcribed.]';

/**
 * A transcription can complete with nothing in it (a barge-in of pure noise).
 * A blank user message is worse than a marker: model providers reject blank
 * text blocks outright, so one empty line poisons every later run that loads
 * the conversation.
 */
function hasSpokenText(batch: Extract<VoiceHistoryBatch, { kind: 'user-turn' }>): boolean {
  return batch.transcription.status === 'completed' && batch.transcription.text.trim() !== '';
}

function callerText(batch: Extract<VoiceHistoryBatch, { kind: 'user-turn' }>): string {
  const transcription = batch.transcription;
  return transcription.status === 'completed' && transcription.text.trim() !== ''
    ? transcription.text
    : UNAVAILABLE_TRANSCRIPT_MESSAGE;
}

/**
 * The deployed runtime's session-history client. In production these methods
 * traverse SessionManager → StateTree → RpcStateBackend; the platform remains
 * the durable-state authority.
 */
export interface VoiceSessionHistoryPort {
  loadContent(sessionId: string): Promise<AgentContent[]>;
  recordMessagesAndWait(sessionId: string, event: AgentMessages): Promise<void>;
  recordContentAndWait(sessionId: string, event: AgentContentEvent): Promise<void>;
  finalizeSession(sessionId: string): Promise<void>;
}

/** Narrow history capability consumed by a voice transport gateway. */
export interface VoiceConversationHistory {
  loadContent(sessionId: string): Promise<AgentContent[]>;
  recordBatch(
    sessionId: string,
    batch: VoiceHistoryBatch,
    spokenChannel: string,
  ): Promise<AgentContent[]>;
}

/**
 * Maps a terminal provider lifecycle batch onto the ordinary session message
 * and content recorders. It owns no storage and mints no replacement identity.
 */
export class VoiceSessionHistoryClient implements VoiceConversationHistory {
  readonly #sessions: VoiceSessionHistoryPort;

  constructor(sessions: VoiceSessionHistoryPort) {
    this.#sessions = sessions;
  }

  loadContent(sessionId: string): Promise<AgentContent[]> {
    return this.#sessions.loadContent(sessionId);
  }

  async recordBatch(
    sessionId: string,
    batch: VoiceHistoryBatch,
    spokenChannel: string,
  ): Promise<AgentContent[]> {
    const contents = this.#contentsFor(batch, spokenChannel);
    const messageEvent = this.#messagesFor(batch);
    const writes: Promise<void>[] = [];
    if (messageEvent.messages.length > 0) {
      writes.push(this.#sessions.recordMessagesAndWait(sessionId, messageEvent));
    }
    for (const content of contents) {
      const event: AgentContentEvent = { items: [content] };
      if (content.voiceDelivery?.status === 'partial') {
        event.partial = true;
      }
      writes.push(this.#sessions.recordContentAndWait(sessionId, event));
    }
    await Promise.all(writes);
    if (messageEvent.messages.length > 0) {
      await this.#sessions.finalizeSession(sessionId);
    }
    return contents;
  }

  #messagesFor(batch: VoiceHistoryBatch): AgentMessages {
    const messages: ModelMessage[] = [];
    if (batch.kind === 'user-turn' && isLocallyOwned(batch.route.status)) {
      messages.push({ role: 'user', content: callerText(batch) });
      for (const delivery of batch.deliveries) {
        if (delivery.status === 'unconfirmed') {
          continue;
        }
        messages.push({
          role: 'assistant',
          content: delivery.status === 'full' ? delivery.text : INTERRUPTED_VOICE_MESSAGE,
        });
      }
    }
    return { messages, responseId: null, pendingToolCallIds: [] };
  }

  #contentsFor(batch: VoiceHistoryBatch, spokenChannel: string): AgentContent[] {
    const contents: AgentContent[] = [];
    const locallyOwned = batch.kind === 'user-turn' && isLocallyOwned(batch.route.status);
    if (batch.kind === 'user-turn') {
      contents.push(
        createTextContent({
          messageId: userMessageIdFor(`voice:${batch.providerSessionId}:${batch.inputItemId}`),
          content: callerText(batch),
          role: 'user',
          hidden: !locallyOwned || !hasSpokenText(batch) || undefined,
          channel: spokenChannel,
        }),
      );
    }
    for (const delivery of batch.deliveries) {
      const hidden =
        !locallyOwned ||
        delivery.status === 'unconfirmed' ||
        delivery.status === 'partial' ||
        (batch.kind === 'user-turn' && batch.transcription.status === 'failed');
      contents.push(
        createTextContent({
          messageId: `voice:${delivery.providerSessionId}:${delivery.outputItemId}`,
          ...(delivery.runId ? { responseId: delivery.runId } : {}),
          content:
            locallyOwned && delivery.status === 'partial'
              ? INTERRUPTED_VOICE_MESSAGE
              : delivery.text,
          hidden: hidden || undefined,
          channel: spokenChannel,
          voiceDelivery: {
            kind: delivery.kind,
            status: delivery.status,
            ...(delivery.runId ? { runId: delivery.runId } : {}),
            ...(delivery.audioEndMs === undefined ? {} : { audioEndMs: delivery.audioEndMs }),
          },
        }),
      );
    }
    return contents;
  }
}

function isLocallyOwned(status: string): boolean {
  return status === 'local' || status === 'local-failed' || status === 'rejected';
}
