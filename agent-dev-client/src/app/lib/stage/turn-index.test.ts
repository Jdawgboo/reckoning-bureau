import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildTurnIndex } from './turn-index.ts';
import { RAIL_MAX_TURNS, railWindowOffset } from './rail-scrub.ts';
import {
  ContentType,
  type AgentContent,
  type TextContent,
} from '../../../../vendor/agent-library/types/content.ts';

let messageIdCounter = 0;

function userText(
  content: string,
  opts?: { hidden?: boolean; responseId?: string; channel?: string },
): TextContent {
  return {
    messageId: `m${messageIdCounter++}`,
    type: ContentType.Text,
    role: 'user',
    content,
    hidden: opts?.hidden,
    responseId: opts?.responseId,
    channel: opts?.channel,
  };
}

function assistantText(
  content: string,
  opts?: { isReasoning?: boolean; responseId?: string; hidden?: boolean },
): TextContent {
  return {
    messageId: `m${messageIdCounter++}`,
    type: ContentType.Text,
    content,
    isReasoning: opts?.isReasoning,
    responseId: opts?.responseId,
    hidden: opts?.hidden,
  };
}

test('hidden narration never reaches the rail — previews show only what was shown', () => {
  const turns = buildTurnIndex([
    userText('research the rate'),
    assistantText('I am waiting for the latest results to come together.', { hidden: true }),
    assistantText('One zloty is about 27 cents.'),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].responseText, 'One zloty is about 27 cents.');
  assert.doesNotMatch(turns[0].responsePreview, /waiting for the latest/);
});

test('a user text message opens a new turn', () => {
  const messages: AgentContent[] = [userText('do you take walk-ins?')];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, 'do you take walk-ins?');
  assert.equal(turns[0].responsePreview, '');
});

test('hidden user messages open a HOME turn (the welcome page must exist)', () => {
  const messages: AgentContent[] = [
    userText('[user opened the agent]', { hidden: true, responseId: 'resp-w' }),
    assistantText('Welcome to The Studio — take a look below.'),
    userText('book me Thursday'),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].home, true);
  assert.equal(turns[0].request, ''); // synthetic request is never displayed
  assert.equal(turns[0].responseId, 'resp-w');
  assert.ok(turns[0].responseText.includes('Welcome to The Studio')); // the home page content
  assert.equal(turns[1].request, 'book me Thursday');
  assert.equal(turns[1].home, undefined);
});

test('a restored greeting stream with NO user message opens a HOME turn (bug fix — used to be dropped)', () => {
  const messages: AgentContent[] = [
    assistantText('Welcome to The Studio.', { responseId: 'resp-g' }),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].home, true);
  assert.equal(turns[0].request, '');
  assert.equal(turns[0].responseId, 'resp-g');
  assert.ok(turns[0].responseText.includes('Welcome to The Studio'));
  assert.ok(turns[0].responsePreview.includes('Welcome to The Studio'));
});

test('a visible user turn carries its request text', () => {
  const messages: AgentContent[] = [
    userText('do you take walk-ins?', { responseId: 'resp-1' }),
    assistantText('Yes — walk-ins are welcome.'),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, 'do you take walk-ins?');
  assert.equal(turns[0].home, undefined);
  assert.equal(turns[0].responsePreview, 'Yes — walk-ins are welcome.');
});

test('an agent-initiated run mid-stream (new responseId, no user message) opens its own turn', () => {
  const messages: AgentContent[] = [
    userText('book me Thursday', { responseId: 'resp-1' }),
    assistantText('Thursday has 5 open slots.', { responseId: 'resp-1' }),
    assistantText('Reminder: your appointment is tomorrow.', { responseId: 'resp-2' }),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].request, 'book me Thursday');
  assert.equal(turns[0].responseText, 'Thursday has 5 open slots.');
  assert.equal(turns[1].home, undefined);
  assert.equal(turns[1].request, '');
  assert.equal(turns[1].responseId, 'resp-2');
  assert.equal(turns[1].responseText, 'Reminder: your appointment is tomorrow.');
});

test('an optimistic id-less user message joined by its run content stays ONE turn', () => {
  const messages: AgentContent[] = [
    userText('book me Thursday'), // no responseId yet — live optimistic send
    assistantText('Thursday has 5 open slots.', { responseId: 'resp-1' }),
    assistantText('Want me to confirm it?', { responseId: 'resp-1' }),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].request, 'book me Thursday');
  assert.equal(turns[0].responseId, 'resp-1');
  assert.equal(turns[0].responseText, 'Thursday has 5 open slots. Want me to confirm it?');
});

test('assistant text accumulates into the current turn preview', () => {
  const messages: AgentContent[] = [
    userText('do you take walk-ins?'),
    assistantText('Yes — walk-ins are welcome on weekdays.'),
    assistantText('Most sessions can start within 15 minutes of arrival.'),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(
    turns[0].responsePreview,
    'Yes — walk-ins are welcome on weekdays. Most sessions can start within 15 minutes of arrival.',
  );
});

test('response preview is capped at 160 chars', () => {
  const long = 'x'.repeat(100);
  const messages: AgentContent[] = [
    userText('what does it cost?'),
    assistantText(long),
    assistantText(long),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].responsePreview.length, 160);
});

test('reasoning text is skipped from the preview', () => {
  const messages: AgentContent[] = [
    userText('book me Thursday'),
    assistantText('thinking about calendars...', { isReasoning: true }),
    assistantText('Thursday has 5 open slots.'),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].responsePreview, 'Thursday has 5 open slots.');
});

test('responseId is carried from the user message onto the turn', () => {
  const messages: AgentContent[] = [userText('book me Thursday', { responseId: 'resp-1' })];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].responseId, 'resp-1');
});

test('turn identities stay unique when separated groups share a responseId', () => {
  const openingRequest = userText('show financing options', { responseId: 'shared-run' });
  const firstRepeatedResponse = assistantText('CareCredit is available.', {
    responseId: 'shared-run',
  });
  const secondRepeatedResponse = assistantText('PatientFi is also available.', {
    responseId: 'shared-run',
  });
  const messages: AgentContent[] = [
    openingRequest,
    assistantText('Here are the options.', { responseId: 'shared-run' }),
    userText('[voice input]', { hidden: true, responseId: 'voice-run-1' }),
    firstRepeatedResponse,
    userText('[voice input]', { hidden: true, responseId: 'voice-run-2' }),
    secondRepeatedResponse,
  ];

  const turns = buildTurnIndex(messages);
  const repeatedRunTurns = turns.filter((turn) => turn.responseId === 'shared-run');

  assert.equal(repeatedRunTurns.length, 3);
  assert.deepEqual(
    repeatedRunTurns.map((turn) => turn.id),
    [openingRequest.messageId, firstRepeatedResponse.messageId, secondRepeatedResponse.messageId],
  );
  assert.equal(new Set(turns.map((turn) => turn.id)).size, turns.length);
});

test('turn identities remain stable when new groups enter the rail window', () => {
  const messages: AgentContent[] = [];
  for (let index = 0; index < RAIL_MAX_TURNS; index++) {
    const responseId = `run-${index}`;
    messages.push(
      userText(`Request ${index}`, { responseId }),
      assistantText(`Response ${index}`, { responseId }),
    );
  }
  const beforeAppend = buildTurnIndex(messages);

  const afterAppend = buildTurnIndex([
    ...messages,
    userText('compare monthly payments', { responseId: 'next-run' }),
    assistantText('Here is the comparison.', { responseId: 'next-run' }),
  ]);
  const beforeVisible = beforeAppend.slice(railWindowOffset(beforeAppend.length));
  const afterVisible = afterAppend.slice(railWindowOffset(afterAppend.length));

  assert.deepEqual(
    afterVisible.slice(0, -1).map((turn) => turn.id),
    beforeVisible.slice(1).map((turn) => turn.id),
  );
  assert.equal(afterVisible.length, RAIL_MAX_TURNS);
  assert.equal(afterVisible.at(-1)?.request, 'compare monthly payments');
});

test('channel is carried from the user message onto the turn', () => {
  const messages: AgentContent[] = [userText('what are your hours?', { channel: 'voice' })];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].channel, 'voice');
});

test('a typed turn (no channel) carries channel undefined', () => {
  const messages: AgentContent[] = [userText('what are your hours?')];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].channel, undefined);
});

test('content before any user turn has opened is KEPT as a home turn, not dropped', () => {
  const messages: AgentContent[] = [assistantText('stray text with no turn yet')];
  const turns = buildTurnIndex(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].home, true);
  assert.equal(turns[0].responseText, 'stray text with no turn yet');
});

test('responseText accumulates the full assistant text uncapped', () => {
  const long = 'x'.repeat(100);
  const messages: AgentContent[] = [
    userText('what does it cost?'),
    assistantText(long),
    assistantText(long),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].responseText.length, 201); // 100 + ' ' + 100, uncapped
  assert.equal(turns[0].responsePreview.length, 160); // preview still capped
});

test('reasoning text is skipped from responseText too', () => {
  const messages: AgentContent[] = [
    userText('book me Thursday'),
    assistantText('thinking about calendars...', { isReasoning: true }),
    assistantText('Thursday has 5 open slots.'),
  ];
  const turns = buildTurnIndex(messages);
  assert.equal(turns[0].responseText, 'Thursday has 5 open slots.');
});
