/**
 * Attachment-level behaviour only: what the deployed channel asks its provider
 * seam for, never how a provider renders it. The wire is the adapter's contract
 * and is asserted in `agentplace-voice`.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import type {
  VoiceDeliveryOutput,
  VoiceDeliveryPolicy,
  VoiceDeliverySettlement,
} from '../../vendor/agentplace-voice/delivery-policy.ts';
import {
  ScriptedUpstream,
  type ScriptedUpstreamSession,
} from '../../vendor/agentplace-voice/test-utils/scripted-upstream.ts';
import { OPENAI_REALTIME_CAPABILITIES } from '../../vendor/agentplace-voice/openai-realtime-upstream.ts';
import type { RoleTools } from '../../vendor/agentplace-voice/voice-tool-executor.ts';
import {
  createComponent,
  createTextContent,
  createToolContent,
} from '../bl/agent/agent-library.ts';
import {
  SCREENLESS_AGENT_RUN_PRESENTATION,
  type AgentRunPresentationCapability,
} from '../bl/messaging/agent-run-presentation.ts';
import { AgentSession } from './agent-session.ts';
import {
  DeployedVoiceAttachment,
  type DeployedVoiceProfile,
  type DeployedVoiceTurnProcessor,
} from './deployed-voice-attachment.ts';
import type { VoiceConversationHistory } from './voice-session-history.ts';
import { BROWSER_ACTIVE_RUN_SILENCE_POLICY } from '../../vendor/agentplace-voice/speech-scheduler.ts';

class ImmediateDeliveryPolicy implements VoiceDeliveryPolicy {
  #settlement: VoiceDeliverySettlement | null = null;

  start(settlement: VoiceDeliverySettlement): void {
    this.#settlement = settlement;
  }

  handleAttachmentEvent(_event: Record<string, unknown>): boolean {
    return false;
  }

  handleProviderEvent(_event: Record<string, unknown>): void {}

  onOutputTerminal(output: VoiceDeliveryOutput): void {
    this.#settlement?.markPlaybackCompleted(output.itemId);
  }

  onOutputSettled(_itemId: string): void {}

  dispose(): void {}
}

/** A client link that records what reached the browser. */
function clientLink() {
  const sent: Record<string, unknown>[] = [];
  const closeHandlers = new Set<() => void>();
  let closed = false;
  return {
    sent,
    link: {
      send: (event: Record<string, unknown>) => void sent.push(event),
      onClose: (handler: () => void) => {
        if (closed) {
          handler();
          return;
        }
        closeHandlers.add(handler);
      },
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        for (const handler of closeHandlers) {
          handler();
        }
      },
    },
  };
}

const PROFILE: DeployedVoiceProfile = {
  instructions: 'Help by voice.',
  voice: 'marin',
  speakFirst: true,
  busyToolNames: ['handle_request'],
  greetingInstructions: 'Greet briefly.',
  admissionInstructions: 'Acknowledge admission briefly: ',
  progressInstructions: 'Say the progress fact briefly: ',
  relayInstructions: 'Relay briefly: ',
  livenessInstructions: 'Keep the listener briefly oriented without claiming progress.',
};

/** The provider acknowledges the Nth speech request and finishes that turn. */
function runTurn(session: ScriptedUpstreamSession, index: number): void {
  const turnId = `turn_${index}`;
  session.emit({
    type: 'model.turn.started',
    turnId,
    reason: session.speakRequests[index - 1]?.reason ?? 'unprompted',
  });
  session.emit({ type: 'model.turn.ended', turnId, outcome: 'completed' });
}

async function attachTestVoice(session: AgentSession, id: string) {
  const history: VoiceConversationHistory = {
    loadContent: async () => [],
    recordBatch: async () => [],
  };
  const messageProcessor: DeployedVoiceTurnProcessor = {
    handleMessageSend: async () => ({ accepted: true, responseId: `${id}-run` }),
    handleMessageAbort: async () => ({ aborted: true }),
    getActiveResponseId: () => undefined,
  };
  const prepared = await DeployedVoiceAttachment.prepare({
    session,
    sessionHistory: history,
    messageProcessor,
    capabilities: [],
    screen: { kind: 'absent' },
    channel: 'voice',
    runPresentation: SCREENLESS_AGENT_RUN_PRESENTATION,
  });
  const configured = prepared.configure(PROFILE);
  const upstream = new ScriptedUpstream({ capabilities: OPENAI_REALTIME_CAPABILITIES });
  const client = clientLink();
  const attachment = await configured.attach({
    upstream,
    client: client.link,
    deliveryPolicy: new ImmediateDeliveryPolicy(),
  });
  return { attachment, client, providerSession: upstream.sessions[0] };
}

describe('DeployedVoiceAttachment channel contract', () => {
  it('re-reads the committed locale for every provider response', async () => {
    const session = new AgentSession({
      sessionKey: 'voice-locale',
      userId: 'user-1',
      configId: 'agent-1',
      ttlMs: 60_000,
    });
    const attached = await attachTestVoice(session, 'locale-provider');
    attached.attachment.activate({ speakFirst: false });

    attached.providerSession.emit({
      type: 'caller.turn.committed',
      callerItemId: 'locale-input-1',
    });
    assert.match(attached.providerSession.speakRequests[0]?.text ?? '', /language is en/);
    runTurn(attached.providerSession, 1);

    await session.proposeLocale('ru', 'explicit');
    attached.providerSession.emit({
      type: 'caller.turn.committed',
      callerItemId: 'locale-input-2',
    });
    assert.match(attached.providerSession.speakRequests[1]?.text ?? '', /language is ru/);
    attached.client.link.close();
  });

  it('prepares context before provider binding and preserves screenless run authority', async () => {
    const session = new AgentSession({
      sessionKey: 'screenless-voice',
      userId: 'user-1',
      configId: 'agent-1',
      ttlMs: 60_000,
    });
    const historyLoads: string[] = [];
    const history: VoiceConversationHistory = {
      loadContent: async (sessionKey) => {
        historyLoads.push(sessionKey);
        return [
          createTextContent({
            messageId: 'existing-user-turn',
            content: 'What are your opening hours?',
            role: 'user',
            channel: 'voice',
          }),
        ];
      },
      recordBatch: async () => [],
    };
    const runPresentations: AgentRunPresentationCapability[] = [];
    const messageProcessor: DeployedVoiceTurnProcessor = {
      handleMessageSend: async (_peer, _connectionId, _session, _params, runPresentation) => {
        runPresentations.push(runPresentation);
        return { accepted: true, responseId: 'run-1' };
      },
      handleMessageAbort: async () => ({ aborted: true }),
      getActiveResponseId: () => undefined,
    };

    const prepared = await DeployedVoiceAttachment.prepare({
      session,
      sessionHistory: history,
      messageProcessor,
      capabilities: [],
      screen: { kind: 'absent' },
      channel: 'voice',
      runPresentation: SCREENLESS_AGENT_RUN_PRESENTATION,
    });

    assert.deepStrictEqual(historyLoads, ['screenless-voice']);
    assert.strictEqual(prepared.hasHistory, true);

    const roleTools: RoleTools = {
      definitions: [
        {
          type: 'function',
          name: 'channel_specific_action',
          description: 'A capability supplied by this channel.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      execute: async () => null,
    };
    const configured = prepared.configure(PROFILE, roleTools);
    assert.ok(
      configured.toolDefinitions.some((tool) => tool.name === 'channel_specific_action'),
      'a channel capability reaches the provider tool list',
    );

    const upstream = new ScriptedUpstream({ capabilities: OPENAI_REALTIME_CAPABILITIES });
    const client = clientLink();
    const attachment = await configured.attach({
      upstream,
      client: client.link,
      deliveryPolicy: new ImmediateDeliveryPolicy(),
    });
    const providerSession = upstream.sessions[0];

    assert.ok(
      upstream.openConfigs[0].tools.some((tool) => tool.name === 'channel_specific_action'),
      'the session opens holding the channel capability',
    );
    assert.strictEqual(
      providerSession.speakRequests.length,
      0,
      'a prepared attachment stays silent until it is activated',
    );

    attachment.activate({ speakFirst: false });
    assert.strictEqual(providerSession.speakRequests.length, 0, 'no greeting was asked for');

    providerSession.emit({ type: 'caller.turn.committed', callerItemId: 'phone-input-1' });
    assert.strictEqual(providerSession.speakRequests.length, 1, 'the caller turn asks for a reply');
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'Are you open on Sunday?' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(runPresentations, [SCREENLESS_AGENT_RUN_PRESENTATION]);
    client.link.close();
  });

  it('closes the previous deployed listener when its replacement activates', async () => {
    const session = new AgentSession({
      sessionKey: 'exclusive-voice',
      userId: 'user-1',
      configId: 'agent-1',
      ttlMs: 60_000,
    });
    const first = await attachTestVoice(session, 'first-provider');
    first.attachment.activate({ speakFirst: false });
    const second = await attachTestVoice(session, 'second-provider');

    second.attachment.activate({ speakFirst: false });

    assert.strictEqual(first.providerSession.closed, true, 'the superseded listener is closed');
    assert.strictEqual(second.providerSession.closed, false);
    assert.strictEqual(session.voiceChannelActive, true);
    first.client.link.close();
    assert.strictEqual(session.voiceChannelActive, true);

    second.client.link.close();
    assert.strictEqual(session.voiceChannelActive, false);
  });

  it('orients the listener during a voice-originated run, then speaks its terminal fact', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = new AgentSession({
      sessionKey: 'deployed-speech-flow',
      userId: 'user-1',
      configId: 'agent-1',
      ttlMs: 60_000,
    });
    const history: VoiceConversationHistory = {
      loadContent: async () => [],
      recordBatch: async () => [],
    };
    const messageProcessor: DeployedVoiceTurnProcessor = {
      handleMessageSend: async () => {
        session.notifyTurnAccepted('run-1');
        return { accepted: true, responseId: 'run-1' };
      },
      handleMessageAbort: async () => ({ aborted: true }),
      getActiveResponseId: () => undefined,
    };
    const prepared = await DeployedVoiceAttachment.prepare({
      session,
      sessionHistory: history,
      messageProcessor,
      capabilities: [],
      screen: { kind: 'summary' },
      channel: 'voice',
      runPresentation: SCREENLESS_AGENT_RUN_PRESENTATION,
    });
    const configured = prepared.configure(PROFILE);
    const upstream = new ScriptedUpstream({ capabilities: OPENAI_REALTIME_CAPABILITIES });
    const client = clientLink();
    const attachment = await configured.attach({
      upstream,
      client: client.link,
      deliveryPolicy: new ImmediateDeliveryPolicy(),
    });
    const providerSession = upstream.sessions[0];
    attachment.activate({ speakFirst: false });

    attachment.handleAttachmentEvent({
      type: 'voice.input',
      text: 'Find the nearest office and show it on a map.',
    });
    assert.strictEqual(providerSession.speakRequests.length, 1, 'the typed turn asks for a reply');
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'Find the nearest office and show it on a map.' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));

    t.mock.timers.tick(BROWSER_ACTIVE_RUN_SILENCE_POLICY.initialSilenceMs - 1);
    assert.strictEqual(
      providerSession.speakRequests.length,
      1,
      'silence alone is not yet an obligation to speak',
    );
    t.mock.timers.tick(1);
    assert.strictEqual(providerSession.speakRequests[1]?.reason, 'liveness');
    runTurn(providerSession, 2);

    session.broadcastContent(
      createTextContent({
        messageId: 'reasoning-1',
        responseId: 'run-1',
        content: 'Private chain of thought and routing notes.',
        isReasoning: true,
      }),
    );
    session.broadcastContent(
      createToolContent({
        messageId: 'tool-1',
        responseId: 'run-1',
        tool: { name: 'SearchPlaces' },
        content: { internalProviderPayload: 'must stay private' },
        streaming: {
          toolName: 'SearchPlaces',
          toolCallId: 'call-search-1',
          state: 'output-available',
        },
      }),
    );
    session.broadcastContent(
      createComponent({
        messageId: 'map-1',
        responseId: 'run-1',
        componentName: 'Surface',
        fallbackMarkdown: 'Map centered on the Warsaw office.',
        streaming: {
          toolName: 'RenderMap',
          toolCallId: 'call-map-1',
          state: 'output-available',
        },
      }),
    );

    assert.strictEqual(
      providerSession.speakRequests.length,
      2,
      'reasoning, tool steps, and non-blocking UI facts do not trigger speech',
    );

    session.broadcastContent(
      createTextContent({
        messageId: 'answer-1',
        responseId: 'run-1',
        content: 'Our nearest office is in central Warsaw, and it is now shown on the map.',
      }),
    );
    session.broadcastContent({ type: 'finish', messageId: 'finish', responseId: 'run-1' });

    assert.strictEqual(providerSession.speakRequests.length, 3);
    const relay = providerSession.speakRequests[2];
    assert.strictEqual(relay.reason, 'relay');
    assert.match(relay.text, /nearest office is in central Warsaw/);
    assert.doesNotMatch(relay.text, /Private chain of thought/);
    assert.doesNotMatch(relay.text, /internalProviderPayload/);
    assert.match(
      relay.text,
      /LATEST DELIVERED RESULT: Surface — Map centered on the Warsaw office/,
    );

    client.link.close();
  });
});
