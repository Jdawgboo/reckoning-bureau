/**
 * Attachment-level scenarios: a real `AgentSession`, a real attachment, a real
 * manager and delivery policy, a scripted provider and a scripted browser.
 *
 * These cover what only the runtime can answer — who a run belongs to, what a
 * reattached session already knows, and which work may be spoken about at all.
 * Provider protocol lives in `agentplace-voice`; naturalness lives in the live
 * product scenarios.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createBrowserPcm24DeliveryPolicy } from '../../vendor/agentplace-voice/delivery-policy.ts';
import { OPENAI_REALTIME_CAPABILITIES } from '../../vendor/agentplace-voice/openai-realtime-upstream.ts';
import { ScriptedBrowser } from '../../vendor/agentplace-voice/test-utils/scripted-browser.ts';
import {
  ScriptedUpstream,
  type ScriptedUpstreamSession,
} from '../../vendor/agentplace-voice/test-utils/scripted-upstream.ts';
import {
  InMemoryStateBackend,
  SessionManager,
  StateTree,
  createComponent,
  createTextContent,
  createToolContent,
} from '../bl/agent/agent-library.ts';
import { ReportProgressTool } from '../bl/tools/impl/report-progress.tool.ts';
import { SCREENLESS_AGENT_RUN_PRESENTATION } from '../bl/messaging/agent-run-presentation.ts';
import { AgentSession } from './agent-session.ts';
import {
  DeployedVoiceAttachment,
  type DeployedVoiceProfile,
  type DeployedVoiceTurnProcessor,
} from './deployed-voice-attachment.ts';
import { VoiceSessionHistoryClient } from './voice-session-history.ts';

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

function audioBytes(ms: number): Buffer {
  return Buffer.alloc(ms * 48);
}

/** The provider speaks one whole turn. */
function speaks(session: ScriptedUpstreamSession, index: number, text: string, ms = 500): void {
  const turnId = `turn_${index}`;
  session.emit({
    type: 'model.turn.started',
    turnId,
    reason: session.speakRequests[index - 1]?.reason ?? 'unprompted',
  });
  session.emit({ type: 'model.audio', audio: audioBytes(ms), turnId });
  session.emit({ type: 'model.text', text, turnId, final: false });
  session.emit({ type: 'model.audio.done', turnId });
  session.emit({ type: 'model.turn.ended', turnId, outcome: 'completed' });
}

async function attach(options: {
  sessionKey: string;
  storedContent?: ReturnType<typeof createTextContent>[];
  echoBeforeAccept?: boolean;
}) {
  const session = new AgentSession({
    sessionKey: options.sessionKey,
    userId: 'user-1',
    configId: 'agent-1',
    ttlMs: 60_000,
  });
  // The real durable path: the same history client the runtime wires, over a
  // real SessionManager and StateTree. Only the storage adapter is in-memory,
  // so what a reload would show is what these assertions read back.
  const backend = new InMemoryStateBackend();
  const sessions = new SessionManager(new StateTree(backend), { agentId: 'agent-1' });
  for (const content of options.storedContent ?? []) {
    await sessions.recordContentAndWait(options.sessionKey, { items: [content] });
  }
  const history = new VoiceSessionHistoryClient(sessions);
  const messageProcessor: DeployedVoiceTurnProcessor = {
    handleMessageSend: async () => {
      session.notifyTurnAccepted('run-voice');
      if (options.echoBeforeAccept) {
        // Production ordering: the processor broadcasts the run's user echo
        // BEFORE its acceptance resolves back to the voice executor — the
        // attachment learns about the run from content first.
        session.broadcastContent({
          ...createTextContent({
            messageId: 'um-echo-1',
            content: 'research the zloty rate',
            role: 'user',
          }),
          responseId: 'run-voice',
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { accepted: true, responseId: 'run-voice' };
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
  const browser = new ScriptedBrowser();
  const attachment = await configured.attach({
    upstream,
    client: browser.clientLink,
    deliveryPolicy: createBrowserPcm24DeliveryPolicy(),
  });
  const providerSession = upstream.sessions[0];
  browser.connectTo({ handleClientEvent: (event) => attachment.handleAttachmentEvent(event) });
  return {
    session,
    attachment,
    prepared,
    browser,
    providerSession,
    storedContent: () => sessions.loadContent(options.sessionKey),
  };
}

describe('voice scenarios — attaching to a session that has a past', () => {
  it('reopens a spoken conversation without greeting again or replaying it', async () => {
    const spoken = [
      createTextContent({
        messageId: 'voice:earlier:1',
        content: 'What are your opening hours?',
        role: 'user',
        channel: 'voice',
      }),
      createTextContent({
        messageId: 'voice:earlier:2',
        content: 'We are open until six on weekdays.',
        channel: 'voice',
        voiceDelivery: { kind: 'relay', status: 'full' },
      }),
    ];
    const { attachment, prepared, providerSession } = await attach({
      sessionKey: 'reopened-voice',
      storedContent: spoken,
    });

    assert.strictEqual(prepared.hasHistory, true, 'the session knows it has been spoken to');
    const seeded = providerSession.contextWrites.map((write) => write.text).join('\n');
    assert.match(seeded, /open until six/, 'what was heard before is common ground again');

    attachment.activate({ speakFirst: !prepared.hasHistory });

    assert.strictEqual(
      providerSession.speakRequests.length,
      0,
      'a conversation already under way is not greeted a second time',
    );
    assert.strictEqual(
      providerSession.contextWrites.filter((write) => write.role === 'user').length >= 1,
      true,
      'the caller’s own earlier words are restored as conversation, not as speech',
    );
  });

  it('greets a resumed conversation when the browser claims its first voice open', async () => {
    const spoken = [
      createTextContent({
        messageId: 'text:earlier:1',
        content: 'Welcome! I can help you book a table.',
      }),
    ];
    const { attachment, prepared, providerSession } = await attach({
      sessionKey: 'welcome-turn-then-voice',
      storedContent: spoken,
    });
    assert.strictEqual(
      prepared.hasHistory,
      true,
      'the automatic welcome turn already counts as history',
    );

    // This is the everyday case: the page loads, the agent renders its welcome
    // turn, THEN the visitor switches voice on for the first time. History is
    // never empty here, so the greeting can only come from the browser's own
    // first-open fact — the exact gap that kept voice silent in production.
    attachment.activate({ speakFirst: true });

    assert.strictEqual(providerSession.speakRequests.length, 1);
    assert.strictEqual(providerSession.speakRequests[0]?.reason, 'greeting');
  });

  it('greets a visitor whose conversation is fresh, exactly once', async () => {
    const { attachment, prepared, providerSession, browser } = await attach({
      sessionKey: 'first-ever-voice',
    });
    assert.strictEqual(prepared.hasHistory, false);

    // The gateway activates with the attachment's own default: greet when
    // nothing has been said yet. This is the requirement the builder surface
    // silently unmade once — pinned here so the deployed one cannot.
    attachment.activate();

    assert.strictEqual(providerSession.speakRequests.length, 1);
    assert.strictEqual(providerSession.speakRequests[0]?.reason, 'greeting');
    speaks(providerSession, 1, 'Hi — how can I help today?');
    browser.playAll();

    attachment.activate();
    assert.strictEqual(
      providerSession.speakRequests.length,
      1,
      'a second activation must not produce a second greeting',
    );
  });

  it('stays silent about a run the visitor started on screen', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { session, attachment, browser, providerSession } = await attach({
      sessionKey: 'screen-origin-voice',
    });
    attachment.activate({ speakFirst: false });

    session.broadcastContent(
      createTextContent({
        messageId: 'answer-1',
        responseId: 'run-typed',
        content: 'Your appointment is confirmed for Friday.',
      }),
    );
    session.broadcastContent({ type: 'finish', messageId: 'finish', responseId: 'run-typed' });

    assert.strictEqual(
      providerSession.speakRequests.length,
      0,
      'work the visitor drove on screen is context, never an announcement',
    );
    assert.deepStrictEqual(browser.sentOfType('voice.playback.completed'), []);

    // …but voice still learns what the visitor read, immediately and with the
    // answer intact: a run that is never spoken has no delivery to wait for.
    const ledger = providerSession.contextWrites.map((write) => write.text).join('\n');
    assert.match(ledger, /confirmed for Friday/);
    assert.match(ledger, /seen-on-screen/);
    assert.doesNotMatch(ledger, /delivery could not be confirmed/);

    t.mock.timers.tick(30_000);
    assert.strictEqual(
      providerSession.contextWrites.filter((write) => write.text.includes('confirmed for Friday'))
        .length,
      1,
      'and it is written once, not again when a park would have expired',
    );
  });

  it('speaks the fact even when the run echo outraces the acceptance — origin upgrades to voice', async () => {
    const { attachment, providerSession, session } = await attach({
      sessionKey: 'race-origin',
      echoBeforeAccept: true,
    });
    attachment.activate({ speakFirst: false });
    attachment.handleAttachmentEvent({ type: 'voice.input', text: 'research the zloty rate' });
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'research the zloty rate' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const spokenBefore = providerSession.speakRequests.length;

    session.broadcastContent(
      createComponent({
        messageId: 'call-research-race',
        responseId: 'run-voice',
        componentName: 'DeepResearch',
        props: { status: 'running', searchCount: 1 },
        streaming: {
          toolName: 'deep_research',
          toolCallId: 'call-research-race',
          state: 'output-pending',
        },
        progress: { text: 'Checked 1 search and found 6 distinct sources.' },
      }),
    );

    const spoken = providerSession.speakRequests.slice(spokenBefore);
    assert.strictEqual(
      spoken.length,
      1,
      'a spoken request stays voice-origin however the race lands',
    );
    assert.strictEqual(spoken[0]?.reason, 'progress');
  });

  it('speaks a producer fact published mid-execution (output-pending), deployed path', async () => {
    const { attachment, providerSession, session } = await attach({
      sessionKey: 'midrun-progress',
    });
    attachment.activate({ speakFirst: false });
    attachment.handleAttachmentEvent({ type: 'voice.input', text: 'research the zloty rate' });
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'research the zloty rate' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    const spokenBefore = providerSession.speakRequests.length;

    session.broadcastContent(
      createComponent({
        messageId: 'call-research-1',
        responseId: 'run-voice',
        componentName: 'DeepResearch',
        props: { status: 'running', searchCount: 1 },
        streaming: {
          toolName: 'deep_research',
          toolCallId: 'call-research-1',
          state: 'output-available',
        },
        progress: { text: 'Checked 1 search and found 4 distinct sources.' },
      }),
    );

    const spoken = providerSession.speakRequests.slice(spokenBefore);
    assert.strictEqual(spoken.length, 1, 'the mid-execution fact is spoken');
    assert.strictEqual(spoken[0]?.reason, 'progress');
    assert.match(spoken[0].text, /Checked 1 search and found 4 distinct sources/);
  });

  it('speaks a completed web search as its own fact, mid-run — no liveness needed', async () => {
    const { attachment, providerSession, session } = await attach({
      sessionKey: 'web-search-progress',
    });
    attachment.activate({ speakFirst: false });
    attachment.handleAttachmentEvent({ type: 'voice.input', text: 'what is the zloty rate' });
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'what is the zloty rate' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    const spokenBefore = providerSession.speakRequests.length;

    session.broadcastContent(
      createToolContent({
        messageId: 'tool-search-1',
        responseId: 'run-voice',
        tool: { name: 'web_search' },
        content: {},
        streaming: {
          toolName: 'web_search',
          toolCallId: 'call-2',
          state: 'output-available',
          input: { query: 'PLN to USD exchange rate' },
        },
      }),
    );

    const spoken = providerSession.speakRequests.slice(spokenBefore);
    assert.strictEqual(spoken.length, 1, 'the completed search is spoken once');
    assert.strictEqual(spoken[0]?.reason, 'progress');
    assert.match(spoken[0].text, /Checking the web/);
    assert.doesNotMatch(
      spoken[0].text,
      /PLN to USD exchange rate/,
      'the raw query is never spoken',
    );
  });

  it('speaks the agent’s own report of work it has finished, mid-run', async () => {
    const { attachment, browser, providerSession, session } = await attach({
      sessionKey: 'agent-reported-progress',
    });
    attachment.activate({ speakFirst: false });
    attachment.handleAttachmentEvent({ type: 'voice.input', text: 'find me a slot this week' });
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'find me a slot this week' },
    });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    const spokenBefore = providerSession.speakRequests.length;

    // The agent, mid-run, says what it has done — through the ordinary tool it
    // is granted only while someone is listening.
    const reported = await new ReportProgressTool().execute(
      { progress: 'Checked four of the six branches for a free slot.' },
      { runner: { state: undefined }, toolCallId: 'call-2' },
    );
    session.broadcastContent(
      createToolContent({
        messageId: 'tool-1',
        responseId: 'run-voice',
        tool: { name: 'report_progress' },
        content: {},
        streaming: {
          toolName: 'report_progress',
          toolCallId: 'call-2',
          state: 'output-available',
        },
        progress: reported.progress,
      }),
    );

    const spoken = providerSession.speakRequests.slice(spokenBefore);
    assert.strictEqual(spoken.length, 1, 'the report is spoken once');
    assert.strictEqual(spoken[0]?.reason, 'progress');
    assert.match(spoken[0].text, /Checked four of the six branches/);
    assert.doesNotMatch(spoken[0].text, /report_progress/, 'the tool itself is never mentioned');
    browser.playAll();
  });

  it('speaks a voice-originated run through to its result, and records what was heard', async () => {
    const { attachment, browser, providerSession, storedContent, session } = await attach({
      sessionKey: 'voice-origin-run',
    });
    attachment.activate({ speakFirst: false });

    attachment.handleAttachmentEvent({ type: 'voice.input', text: 'confirm my appointment' });
    assert.strictEqual(providerSession.speakRequests[0]?.reason, 'reply');
    providerSession.emit({ type: 'model.turn.started', turnId: 'turn_1', reason: 'reply' });
    providerSession.emit({
      type: 'tool.called',
      turnId: 'turn_1',
      callId: 'call-1',
      name: 'handle_request',
      args: { instruction: 'confirm my appointment' },
    });
    providerSession.emit({ type: 'model.audio', audio: audioBytes(300), turnId: 'turn_1' });
    providerSession.emit({
      type: 'model.text',
      text: 'One moment.',
      turnId: 'turn_1',
      final: false,
    });
    providerSession.emit({ type: 'model.audio.done', turnId: 'turn_1' });
    providerSession.emit({ type: 'model.turn.ended', turnId: 'turn_1', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    browser.playAll();

    const speechBeforeSurface = providerSession.speakRequests.length;
    session.broadcastContent(
      createComponent({
        messageId: 'actionable-home',
        responseId: 'run-voice',
        componentName: 'Surface',
        props: {
          pendingAction: { component: 'TestHome', label: 'Choose a home action' },
        },
        streaming: {
          toolName: 'RenderSurface',
          toolCallId: 'call-home',
          state: 'output-available',
        },
      }),
    );
    assert.strictEqual(
      providerSession.speakRequests.length,
      speechBeforeSurface,
      'an actionable surface arms voice without speaking before the run terminates',
    );

    session.broadcastContent(
      createTextContent({
        messageId: 'answer-1',
        responseId: 'run-voice',
        content: 'Confirmed for Friday at ten.',
      }),
    );
    session.broadcastContent({ type: 'finish', messageId: 'finish', responseId: 'run-voice' });

    const terminalRequests = providerSession.speakRequests.slice(speechBeforeSurface);
    assert.strictEqual(terminalRequests.length, 1, 'the run produces one terminal relay');
    const relay = terminalRequests[0];
    assert.strictEqual(relay?.reason, 'relay');
    assert.match(relay.text, /Confirmed for Friday at ten\./);
    assert.doesNotMatch(relay.text, /A user decision is required|Question:/);
    speaks(providerSession, providerSession.speakRequests.length, 'You are confirmed for Friday.');
    browser.playAll();

    // What a reload would show: the caller's own turn and the answer they heard,
    // both tagged as voice, written through the ordinary session recorders.
    const stored = await storedContent();
    const spokenLines = stored.filter((item) => item.channel === 'voice');
    assert.ok(spokenLines.length >= 2, 'the spoken exchange reaches durable session history');
    assert.ok(
      spokenLines.some(
        (item) =>
          item.type === 'TXT' &&
          typeof item.content === 'string' &&
          item.content.includes('confirm my appointment'),
      ),
      'the caller’s own words are stored',
    );
    const heard = spokenLines.find((item) => item.voiceDelivery?.status === 'full');
    assert.ok(heard, 'the answer is stored with the evidence that it was heard');
    assert.strictEqual(heard?.voiceDelivery?.runId, 'run-voice');
  });
});
