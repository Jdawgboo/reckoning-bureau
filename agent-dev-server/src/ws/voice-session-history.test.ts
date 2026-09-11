import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoiceHistoryBatch } from '../../vendor/agentplace-voice/voice-history-log.ts';
import {
  InMemoryStateBackend,
  SessionManager,
  StateTree,
  type AgentContent,
} from '../bl/agent/agent-library.ts';
import {
  VoiceSessionHistoryClient,
  type VoiceSessionHistoryPort,
} from './voice-session-history.ts';

function recordingPort(initialContent: AgentContent[] = []) {
  const messageEvents: Parameters<VoiceSessionHistoryPort['recordMessagesAndWait']>[1][] = [];
  const contentEvents: Parameters<VoiceSessionHistoryPort['recordContentAndWait']>[1][] = [];
  const finalized: string[] = [];
  const loads: string[] = [];
  const port: VoiceSessionHistoryPort = {
    async loadContent(sessionId) {
      loads.push(sessionId);
      return initialContent;
    },
    async recordMessagesAndWait(_sessionId, event) {
      messageEvents.push(event);
    },
    async recordContentAndWait(_sessionId, event) {
      contentEvents.push(event);
    },
    async finalizeSession(sessionId) {
      finalized.push(sessionId);
    },
  };
  return { port, messageEvents, contentEvents, finalized, loads };
}

function localBatch(): Extract<VoiceHistoryBatch, { kind: 'user-turn' }> {
  return {
    kind: 'user-turn',
    providerSessionId: 'provider-session-1',
    inputItemId: 'input-1',
    transcription: { status: 'completed', text: 'What price is shown?' },
    route: { status: 'local' },
    deliveries: [
      {
        providerSessionId: 'provider-session-1',
        inputItemId: 'input-1',
        outputItemId: 'output-1',
        kind: 'user-turn',
        status: 'full',
        text: 'It is shown as forty euros.',
      },
    ],
  };
}

describe('VoiceSessionHistoryClient', () => {
  it('loads through the injected platform-backed session history port', async () => {
    const existing: AgentContent[] = [];
    const recording = recordingPort(existing);
    const client = new VoiceSessionHistoryClient(recording.port);

    assert.strictEqual(await client.loadContent('session-1'), existing);
    assert.deepStrictEqual(recording.loads, ['session-1']);
  });

  it('records local dialogue through canonical awaited message and content recorders', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);

    const liveContent = await client.recordBatch('session-1', localBatch(), 'voice');

    assert.deepStrictEqual(recording.messageEvents, [
      {
        messages: [
          { role: 'user', content: 'What price is shown?' },
          { role: 'assistant', content: 'It is shown as forty euros.' },
        ],
        responseId: null,
        pendingToolCallIds: [],
      },
    ]);
    assert.deepStrictEqual(
      recording.contentEvents.map((event) => ({
        messageId: event.items[0]?.messageId,
        role: event.items[0]?.role,
        content: event.items[0]?.type === 'TXT' ? event.items[0].content : undefined,
      })),
      [
        {
          messageId: 'um-voice:provider-session-1:input-1',
          role: 'user',
          content: 'What price is shown?',
        },
        {
          messageId: 'voice:provider-session-1:output-1',
          role: undefined,
          content: 'It is shown as forty euros.',
        },
      ],
    );
    assert.strictEqual(liveContent.length, 2);
    assert.deepStrictEqual(recording.finalized, ['session-1']);
  });

  it('never records a blank caller line — an empty transcript is filed as untranscribable', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);
    const batch = localBatch();
    batch.transcription = { status: 'completed', text: '  ' };

    await client.recordBatch('session-1', batch, 'voice');

    assert.deepStrictEqual(recording.messageEvents[0]?.messages[0], {
      role: 'user',
      content: '[A spoken user turn could not be transcribed.]',
    });
    assert.strictEqual(recording.contentEvents[0]?.items[0]?.hidden, true);
  });

  it('maps channel metadata through the attachment-configured spoken channel', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);

    await client.recordBatch('session-1', localBatch(), 'phone');

    assert.deepStrictEqual(
      recording.contentEvents.map((event) => ({
        channel: event.items[0]?.channel,
        messageId: event.items[0]?.messageId,
      })),
      [
        { channel: 'phone', messageId: 'um-voice:provider-session-1:input-1' },
        { channel: 'phone', messageId: 'voice:provider-session-1:output-1' },
      ],
    );
  });

  it('records delegated speech as hidden delivery evidence under the existing run id', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);
    const batch: VoiceHistoryBatch = {
      kind: 'user-turn',
      providerSessionId: 'provider-session-1',
      inputItemId: 'input-1',
      transcription: { status: 'completed', text: 'Book Friday.' },
      route: { status: 'delegated-queued', runId: 'run-42' },
      deliveries: [
        {
          providerSessionId: 'provider-session-1',
          inputItemId: 'input-1',
          outputItemId: 'output-ack',
          kind: 'user-turn',
          status: 'full',
          text: 'I’ll take care of that.',
          runId: 'run-42',
        },
      ],
    };

    const liveContent = await client.recordBatch('session-1', batch, 'voice');

    assert.deepStrictEqual(recording.messageEvents, []);
    assert.deepStrictEqual(recording.finalized, []);
    const transcription = recording.contentEvents[0]?.items[0];
    assert.strictEqual(transcription?.role, 'user');
    assert.strictEqual(transcription?.hidden, true);
    const delivery = recording.contentEvents[1]?.items[0];
    assert.strictEqual(delivery?.messageId, 'voice:provider-session-1:output-ack');
    assert.strictEqual(delivery?.responseId, 'run-42');
    assert.strictEqual(delivery?.hidden, true);
    assert.deepStrictEqual(delivery?.voiceDelivery, {
      kind: 'user-turn',
      status: 'full',
      runId: 'run-42',
    });
    assert.strictEqual(liveContent[0]?.hidden, true);
  });

  it('marks partial content without placing unheard generated text in model history', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);
    const batch = localBatch();
    batch.deliveries[0] = {
      ...batch.deliveries[0],
      status: 'partial',
      audioEndMs: 420,
    };

    await client.recordBatch('session-1', batch, 'voice');

    assert.deepStrictEqual(recording.messageEvents[0]?.messages, [
      { role: 'user', content: 'What price is shown?' },
      { role: 'assistant', content: '[The voice response was interrupted before completion.]' },
    ]);
    assert.strictEqual(recording.contentEvents[1]?.partial, true);
    assert.strictEqual(recording.contentEvents[1]?.items[0]?.type, 'TXT');
    assert.strictEqual(
      recording.contentEvents[1]?.items[0]?.content,
      '[The voice response was interrupted before completion.]',
    );
    assert.strictEqual(recording.contentEvents[1]?.items[0]?.voiceDelivery?.audioEndMs, 420);
    const partialContent = recording.contentEvents
      .flatMap((event) => event.items)
      .find((item) => item.voiceDelivery?.status === 'partial');
    assert.strictEqual(
      partialContent?.hidden,
      true,
      'the interruption marker is model history, never a visible page',
    );
  });

  it('records an explicit failed-transcription marker so later context has no missing turn', async () => {
    const recording = recordingPort();
    const client = new VoiceSessionHistoryClient(recording.port);
    const batch = localBatch();
    batch.transcription = { status: 'failed' };

    await client.recordBatch('session-1', batch, 'voice');

    assert.deepStrictEqual(recording.messageEvents[0]?.messages, [
      { role: 'user', content: '[A spoken user turn could not be transcribed.]' },
      { role: 'assistant', content: 'It is shown as forty euros.' },
    ]);
    assert.strictEqual(recording.contentEvents.length, 2);
    assert.strictEqual(recording.contentEvents[0]?.items[0]?.hidden, true);
    assert.deepStrictEqual(recording.finalized, ['session-1']);
  });

  it('uses SessionManager serialization so local model messages receive canonical mids', async () => {
    const sessions = new SessionManager(new StateTree(new InMemoryStateBackend()));
    await sessions.getOrCreate('session-1', 'web');
    const client = new VoiceSessionHistoryClient(sessions);

    await client.recordBatch('session-1', localBatch(), 'voice');

    const messages = await sessions.loadConversation('session-1');
    assert.strictEqual(messages.length, 2);
    for (const message of messages) {
      const data = message.data;
      assert.ok(typeof data === 'object' && data !== null);
      const providerOptions = Reflect.get(data, 'providerOptions');
      assert.ok(typeof providerOptions === 'object' && providerOptions !== null);
      const agentplace = Reflect.get(providerOptions, 'agentplace');
      assert.ok(typeof agentplace === 'object' && agentplace !== null);
      assert.strictEqual(typeof Reflect.get(agentplace, 'mid'), 'string');
      assert.strictEqual(message.responseId, undefined);
    }
    const contents = await sessions.loadContent('session-1');
    assert.deepStrictEqual(
      contents.map((content) => content.messageId),
      ['um-voice:provider-session-1:input-1', 'voice:provider-session-1:output-1'],
    );
  });
});
