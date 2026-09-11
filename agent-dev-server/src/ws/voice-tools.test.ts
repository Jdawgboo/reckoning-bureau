import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  VoiceToolExecutorCore,
  buildVoiceToolDefinitions,
} from '../../vendor/agentplace-voice/voice-tool-executor.ts';
import type { PendingAction } from '../../vendor/agentplace-voice/turn-events.ts';
import type { VoiceClientLink } from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import {
  DEPLOYED_VOICE_VOCABULARY,
  composeRoleTools,
  createLocaleRoleTools,
  createMemoryRoleTools,
  createTurnPort,
  type VoiceTurnGateway,
} from './voice-tools.ts';

describe('DEPLOYED_VOICE_VOCABULARY', () => {
  it('names the six tools the realtime model can call', () => {
    const definitions = buildVoiceToolDefinitions(DEPLOYED_VOICE_VOCABULARY);
    assert.deepStrictEqual(
      definitions.map((tool) => tool.name),
      [
        'handle_request',
        'recall_conversation',
        'get_session_status',
        'abort_current_run',
        'answer_pending_action',
        'end_voice_session',
      ],
    );
  });

  it('tells the model that a delegation preamble cannot predict the result', () => {
    const handleRequest = buildVoiceToolDefinitions(DEPLOYED_VOICE_VOCABULARY).find(
      (tool) => tool.name === 'handle_request',
    );
    assert.ok(handleRequest);
    assert.match(handleRequest.description, /requires current business state, capability, action/);
    assert.match(handleRequest.description, /Do not call for a fact already explicit there/);
    assert.match(handleRequest.description, /The preamble only acknowledges/);
    assert.match(
      handleRequest.description,
      /never predicts the result, refuses, or describes how the work happens/,
    );
  });

  it('keeps recall role-specific without intermediary wording', () => {
    const recall = buildVoiceToolDefinitions(DEPLOYED_VOICE_VOCABULARY).find(
      (tool) => tool.name === 'recall_conversation',
    );
    assert.ok(recall);
    assert.match(recall.description, /still use handle_request/);
    assert.doesNotMatch(recall.description, /\bforward(?:ed|ing)?\b/i);
  });
});

function makeTurns(
  over: {
    startResult?: { queued: boolean; responseId: string };
    startError?: Error;
    activeResponseId?: string;
    searchResult?: string;
  } = {},
): { turns: VoiceTurnGateway; sends: string[]; aborts: string[]; searches: string[] } {
  const sends: string[] = [];
  const aborts: string[] = [];
  const searches: string[] = [];
  const turns: VoiceTurnGateway = {
    startTurn: async (content) => {
      sends.push(content);
      if (over.startError) {
        throw over.startError;
      }
      return over.startResult ?? { queued: false, responseId: 'resp-1' };
    },
    abortRun: async (responseId) => {
      aborts.push(responseId);
    },
    activeResponseId: () => over.activeResponseId,
    sessionStatus: () => 'idle',
    searchHistory: async (query) => {
      searches.push(query);
      return over.searchResult ?? 'Earlier the visitor said: "book a haircut"';
    },
  };
  return { turns, sends, aborts, searches };
}

describe('createTurnPort', () => {
  it('reports a started run and resolves "started" for an immediate turn', async () => {
    const { turns, sends } = makeTurns();
    const runStarts: string[] = [];
    const port = createTurnPort({ turns, onRunStarted: (id) => runStarts.push(id) });
    const outcome = await port.startTurn('book me a haircut on Friday');
    assert.deepStrictEqual(outcome, { status: 'started', runId: 'resp-1' });
    assert.deepStrictEqual(sends, ['book me a haircut on Friday']);
    assert.deepStrictEqual(runStarts, ['resp-1']);
  });

  it('resolves "queued" without reporting a run start', async () => {
    const { turns } = makeTurns({ startResult: { queued: true, responseId: 'resp-q' } });
    const runStarts: string[] = [];
    const port = createTurnPort({ turns, onRunStarted: (id) => runStarts.push(id) });
    const outcome = await port.startTurn('and a massage');
    assert.deepStrictEqual(outcome, { status: 'queued', runId: 'resp-q' });
    assert.deepStrictEqual(runStarts, []);
  });

  it('resolves "busy" when the queue is already occupied, without reporting a run start', async () => {
    const { turns } = makeTurns({ startError: new Error('Message already pending') });
    const runStarts: string[] = [];
    const port = createTurnPort({ turns, onRunStarted: (id) => runStarts.push(id) });
    const outcome = await port.startTurn('one more thing');
    assert.deepStrictEqual(outcome, { status: 'busy' });
    assert.deepStrictEqual(runStarts, []);
  });

  it('rethrows any error that is not the queue-full signal', async () => {
    const { turns } = makeTurns({ startError: new Error('network exploded') });
    const port = createTurnPort({ turns, onRunStarted: () => {} });
    await assert.rejects(() => port.startTurn('hello'), /network exploded/);
  });

  it('abortActiveRun reports nothing running when there is no active response', async () => {
    const { turns, aborts } = makeTurns();
    const port = createTurnPort({ turns, onRunStarted: () => {} });
    const aborted = await port.abortActiveRun();
    assert.strictEqual(aborted, false);
    assert.deepStrictEqual(aborts, []);
  });

  it('abortActiveRun aborts the active response and reports true', async () => {
    const { turns, aborts } = makeTurns({ activeResponseId: 'resp-live' });
    const port = createTurnPort({ turns, onRunStarted: () => {} });
    const aborted = await port.abortActiveRun();
    assert.strictEqual(aborted, true);
    assert.deepStrictEqual(aborts, ['resp-live']);
  });

  it('passes sessionStatus and searchHistory through unchanged', async () => {
    const { turns, searches } = makeTurns({
      searchResult: 'Earlier you said: "yes, Friday works"',
    });
    const port = createTurnPort({ turns, onRunStarted: () => {} });
    assert.strictEqual(port.sessionStatus(), 'idle');
    const result = await port.searchHistory('friday');
    assert.strictEqual(result, 'Earlier you said: "yes, Friday works"');
    assert.deepStrictEqual(searches, ['friday']);
  });
});

/**
 * End-to-end behavioral parity: `VoiceToolExecutorCore` wired to
 * `createTurnPort` + `DEPLOYED_VOICE_VOCABULARY` must reproduce the exact
 * spoken outcomes the deleted `VoiceToolExecutor` class produced.
 */
function makeExecutor(
  over: Parameters<typeof makeTurns>[0] & { armedAction?: PendingAction | null } = {},
) {
  const { turns, sends, aborts, searches } = makeTurns(over);
  const runStarts: string[] = [];
  let armedAction: PendingAction | null = over.armedAction ?? null;
  let ended = false;
  const clearCalls: number[] = [];
  const executor = new VoiceToolExecutorCore({
    port: createTurnPort({ turns, onRunStarted: (id) => runStarts.push(id) }),
    vocab: DEPLOYED_VOICE_VOCABULARY,
    getArmedAction: () => armedAction,
    clearArmedAction: () => {
      clearCalls.push(1);
      armedAction = null;
    },
    onSessionEnd: () => {
      ended = true;
    },
  });
  return {
    executor,
    sends,
    aborts,
    searches,
    runStarts,
    clearCalls,
    isEnded: () => ended,
    armAction: (action: PendingAction) => {
      armedAction = action;
    },
  };
}

describe('deployed voice tool executor (VoiceToolExecutorCore over the deployed port)', () => {
  it('handle_request starts a real turn and stays silent (ack came in the calling turn)', async () => {
    const { executor, sends, runStarts } = makeExecutor();
    const result = await executor.execute('handle_request', {
      instruction: 'book me a haircut on Friday',
    });
    assert.strictEqual(result.speak, false);
    assert.deepStrictEqual(sends, ['book me a haircut on Friday']);
    assert.deepStrictEqual(runStarts, ['resp-1']);
  });

  it('a queued request returns a typed queue admission', async () => {
    const { executor, runStarts } = makeExecutor({
      startResult: { queued: true, responseId: 'resp-q' },
    });
    const result = await executor.execute('handle_request', { instruction: 'and a massage' });
    assert.strictEqual(result.speak, true);
    assert.deepStrictEqual(result.outcome, { status: 'queued', runId: 'resp-q' });
    assert.deepStrictEqual(runStarts, []);
  });

  it('a busy queue returns a typed busy admission', async () => {
    const { executor } = makeExecutor({ startError: new Error('Message already pending') });
    const result = await executor.execute('handle_request', { instruction: 'one more thing' });
    assert.strictEqual(result.speak, true);
    assert.deepStrictEqual(result.outcome, { status: 'busy' });
  });

  it('an empty instruction asks the model to clarify without starting work', async () => {
    const { executor, sends } = makeExecutor();
    const result = await executor.execute('handle_request', { instruction: '   ' });
    assert.strictEqual(result.speak, true);
    assert.strictEqual(sends.length, 0);
  });

  it('recall_conversation forwards the query to the port and speaks the result', async () => {
    const { executor, searches } = makeExecutor({ searchResult: 'Earlier you said: "yes"' });
    const result = await executor.execute('recall_conversation', { query: 'availability' });
    assert.strictEqual(result.speak, true);
    assert.deepStrictEqual(result.outcome, {
      status: 'completed',
      result: 'conversation-recall',
      value: 'Earlier you said: "yes"',
    });
    assert.deepStrictEqual(searches, ['availability']);
  });

  it('get_session_status reports status with no technical terms', async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute('get_session_status', {});
    assert.deepStrictEqual(result.outcome, {
      status: 'completed',
      result: 'session-status',
      value: 'idle',
    });
    assert.strictEqual(result.speak, true);
  });

  it('abort_current_run with nothing running confirms briefly', async () => {
    const { executor, aborts } = makeExecutor();
    const result = await executor.execute('abort_current_run', {});
    assert.deepStrictEqual(result.outcome, {
      status: 'needs-input',
      reason: 'nothing-running',
    });
    assert.strictEqual(aborts.length, 0);
  });

  it('abort_current_run aborts the active stream by responseId', async () => {
    const { executor, aborts } = makeExecutor({ activeResponseId: 'resp-live' });
    const result = await executor.execute('abort_current_run', {});
    assert.strictEqual(result.speak, true);
    assert.deepStrictEqual(aborts, ['resp-live']);
  });

  it('answer_pending_action without an armed action redirects to handle_request', async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute('answer_pending_action', { answer: 'the blue one' });
    assert.strictEqual(result.outcome.status, 'needs-input');
    assert.ok(result.outcome.status === 'needs-input');
    assert.match(result.outcome.reason, /handle_request/);
  });

  it('answer_pending_action matches an option and starts a plain turn with its label', async () => {
    const armed = makeExecutor();
    armed.armAction({
      component: 'RenderIntakeForm',
      label: 'Which service?',
      options: [
        { label: 'Haircut', value: 'haircut' },
        { label: 'Massage', value: 'massage' },
      ],
      resume: null,
    });
    const result = await armed.executor.execute('answer_pending_action', { answer: 'massage' });
    assert.strictEqual(result.speak, false);
    assert.deepStrictEqual(armed.sends, ['Massage']);
    assert.deepStrictEqual(armed.clearCalls, [1]);
  });

  it('answer_pending_action re-asks when the answer matches no option and keeps the arm', async () => {
    const armed = makeExecutor();
    armed.armAction({
      component: 'RenderIntakeForm',
      label: 'Which service?',
      options: [{ label: 'Haircut', value: 'haircut' }],
      resume: null,
    });
    const result = await armed.executor.execute('answer_pending_action', { answer: 'pedicure' });
    assert.deepStrictEqual(result.outcome, {
      status: 'needs-input',
      reason: 'option-mismatch',
      options: ['Haircut'],
    });
    assert.strictEqual(armed.sends.length, 0);
    assert.deepStrictEqual(armed.clearCalls, []);
  });

  it('end_voice_session asks the manager to end after the goodbye', async () => {
    const { executor, isEnded } = makeExecutor();
    const result = await executor.execute('end_voice_session', {});
    assert.strictEqual(isEnded(), true);
    assert.strictEqual(result.speak, true);
  });

  it('unknown tools refuse politely without leaking internals', async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute('open_portal', {});
    assert.strictEqual(result.speak, true);
    assert.deepStrictEqual(result.outcome, {
      status: 'failed',
      reason: 'unsupported-by-attachment',
    });
  });
});

function makeClientLink(): {
  client: Pick<VoiceClientLink, 'send'>;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const client: Pick<VoiceClientLink, 'send'> = {
    send: (event) => sent.push(event),
  };
  return { client, sent };
}

describe('createMemoryRoleTools', () => {
  it('names remember_this with a summary-only schema', () => {
    const { client } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    assert.strictEqual(roleTools.definitions.length, 1);
    assert.strictEqual(roleTools.definitions[0].name, 'remember_this');
    assert.deepStrictEqual(roleTools.definitions[0].parameters.required, ['summary']);
  });

  it('a valid summary sends exactly one voice.memory attachment event and stays silent', async () => {
    const { client, sent } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    const result = await roleTools.execute('remember_this', {
      summary: 'The visitor is vegetarian.',
    });
    assert.deepStrictEqual(sent, [{ type: 'voice.memory', summary: 'The visitor is vegetarian.' }]);
    assert.deepStrictEqual(result, {
      outcome: { status: 'completed', result: 'memory-recorded' },
      speak: false,
    });
  });

  it('trims the summary before sending', async () => {
    const { client, sent } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    await roleTools.execute('remember_this', { summary: '  The visitor likes tea.  ' });
    assert.deepStrictEqual(sent, [{ type: 'voice.memory', summary: 'The visitor likes tea.' }]);
  });

  it('a non-string summary sends nothing and returns a silent corrective output', async () => {
    const { client, sent } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    const result = await roleTools.execute('remember_this', { summary: 42 });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(result?.speak, false);
    assert.deepStrictEqual(result?.outcome, {
      status: 'needs-input',
      reason: 'missing-memory-summary',
    });
  });

  it('an empty-string summary sends nothing and returns a silent corrective output', async () => {
    const { client, sent } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    const result = await roleTools.execute('remember_this', { summary: '   ' });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(result?.speak, false);
  });

  it('a name unknown to this role tool set returns null without sending', async () => {
    const { client, sent } = makeClientLink();
    const roleTools = createMemoryRoleTools(client);
    const result = await roleTools.execute('open_portal', {});
    assert.strictEqual(result, null);
    assert.deepStrictEqual(sent, []);
  });
});

describe('VoiceToolExecutorCore wired with createMemoryRoleTools', () => {
  it('remember_this reaches the role tool, and a name unknown to both core and the role tool still refuses politely', async () => {
    const { turns } = makeTurns();
    const { client, sent } = makeClientLink();
    const executor = new VoiceToolExecutorCore({
      port: createTurnPort({ turns, onRunStarted: () => {} }),
      vocab: DEPLOYED_VOICE_VOCABULARY,
      getArmedAction: () => null,
      clearArmedAction: () => {},
      onSessionEnd: () => {},
      roleTools: createMemoryRoleTools(client),
    });

    const remembered = await executor.execute('remember_this', {
      summary: 'The visitor prefers evening appointments.',
    });
    assert.deepStrictEqual(sent, [
      { type: 'voice.memory', summary: 'The visitor prefers evening appointments.' },
    ]);
    assert.strictEqual(remembered.speak, false);

    const refused = await executor.execute('open_portal', {});
    assert.strictEqual(refused.speak, true);
    assert.deepStrictEqual(refused.outcome, {
      status: 'failed',
      reason: 'unsupported-by-attachment',
    });
  });
});

describe('locale voice role tool', () => {
  it('commits through the session authority and composes with memory tools', async () => {
    const { client, sent } = makeClientLink();
    const proposals: Array<{ locale: string; source: string }> = [];
    const committed: string[] = [];
    const roleTools = composeRoleTools(
      createMemoryRoleTools(client),
      createLocaleRoleTools({
        hasScreen: true,
        propose: async (locale, source) => {
          proposals.push({ locale, source });
          return {
            messageLocale: locale,
            formatLocale: locale,
            source,
            revision: 2,
          };
        },
        onCommitted: (locale) => committed.push(locale.messageLocale),
      }),
    );

    assert.deepStrictEqual(
      roleTools.definitions.map((definition) => definition.name),
      ['remember_this', 'set_session_locale'],
    );
    const localeDefinition = roleTools.definitions.find(
      (definition) => definition.name === 'set_session_locale',
    );
    assert.ok(localeDefinition);
    assert.match(localeDefinition.description, /unambiguous one-word greeting counts/i);
    assert.match(JSON.stringify(localeDefinition.parameters), /no explicit preference is locked/i);
    const result = await roleTools.execute('set_session_locale', {
      locale: 'ru',
      evidence: 'explicit',
    });
    assert.deepStrictEqual(proposals, [{ locale: 'ru', source: 'explicit' }]);
    assert.deepStrictEqual(committed, ['ru']);
    assert.strictEqual(result?.speak, true);
    assert.match(String(result?.outcome.status === 'completed' && result.outcome.value), /ru/);
    assert.ok(result?.outcome.status === 'completed');
    assert.match(result.outcome.value ?? '', /Before replying, use handle_request/);
    assert.match(result.outcome.value ?? '', /restate the current answer/);
    assert.match(result.outcome.value ?? '', /facts and entered values must be preserved/);
    assert.match(result.outcome.value ?? '', /completed actions must not be repeated/);

    await roleTools.execute('remember_this', { summary: 'The visitor prefers mornings.' });
    assert.deepStrictEqual(sent, [
      { type: 'voice.memory', summary: 'The visitor prefers mornings.' },
    ]);
  });

  it('rejects noncanonical tags, unknown evidence, and visitor-supplied translations', async () => {
    let calls = 0;
    const roleTools = createLocaleRoleTools({
      hasScreen: true,
      propose: async () => {
        calls += 1;
        return {
          messageLocale: 'en',
          formatLocale: 'en',
          source: 'default',
          revision: 0,
        };
      },
      onCommitted: () => {},
    });
    for (const args of [
      { locale: 'pt-br', evidence: 'explicit' },
      { locale: 'fr', evidence: 'guess' },
      { locale: 'fr', evidence: 'explicit', translatedButton: 'Envoyer' },
    ]) {
      const result = await roleTools.execute('set_session_locale', args);
      assert.strictEqual(result?.outcome.status, 'needs-input');
    }
    assert.strictEqual(calls, 0);
  });

  it('keeps screenless language changes local to the spoken conversation', async () => {
    const roleTools = createLocaleRoleTools({
      hasScreen: false,
      propose: async (locale, source) => ({
        messageLocale: locale,
        formatLocale: locale,
        source,
        revision: 2,
      }),
      onCommitted: () => {},
    });
    const result = await roleTools.execute('set_session_locale', {
      locale: 'ru',
      evidence: 'explicit',
    });
    assert.ok(result?.outcome.status === 'completed');
    assert.strictEqual(result.speak, true);
    assert.match(result.outcome.value ?? '', /Conversation language is ru\. Reply in it now/);
    assert.doesNotMatch(result.outcome.value ?? '', /handle_request|update existing screen/);
  });
});
