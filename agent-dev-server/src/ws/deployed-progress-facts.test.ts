import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createDeployedProgressFacts } from './deployed-progress-facts.ts';
import { createToolContent } from '../bl/agent/agent-library.ts';

function searchPart(overrides: {
  state: 'input-streaming' | 'output-available';
  callId?: string;
  query?: unknown;
}): ReturnType<typeof createToolContent> {
  return createToolContent({
    messageId: 'tool-1',
    responseId: 'run-1',
    tool: { name: 'web_search' },
    content: {},
    streaming: {
      toolName: 'web_search',
      toolCallId: overrides.callId ?? 'call-1',
      state: overrides.state,
      ...(overrides.query === undefined ? {} : { input: { query: overrides.query } }),
    },
  });
}

describe('createDeployedProgressFacts — provider-executed web search', () => {
  it('speaks a visitor-facing counter, never the query text', () => {
    const decorate = createDeployedProgressFacts();
    const decorated = decorate(
      searchPart({ state: 'output-available', query: 'site:nbp.pl "2026-07" USD Table A' }),
    );
    assert.ok(decorated.progress);
    assert.doesNotMatch(decorated.progress.text, /nbp\.pl|site:|2026-07/);
  });

  it('delegates visitor-facing wording to the session formatter', () => {
    const decorate = createDeployedProgressFacts((_messageId, values) =>
      values.count === 1 ? 'Recherche en cours.' : `${values.count} recherches.`,
    );

    const decorated = decorate(searchPart({ state: 'output-available' }));

    assert.strictEqual(decorated.progress?.text, 'Recherche en cours.');
  });

  it('first search speaks, then every third — a burst cannot flood speech', () => {
    const decorate = createDeployedProgressFacts();
    const facts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
      (id) => decorate(searchPart({ state: 'output-available', callId: `call-${id}` })).progress,
    );
    assert.ok(facts[0], 'the first search is announced');
    assert.strictEqual(facts[1], undefined);
    assert.strictEqual(facts[2], undefined);
    assert.ok(facts[3], 'the fourth search reports the running total');
    assert.match(facts[3].text, /4/);
    assert.strictEqual(facts[4], undefined);
    assert.strictEqual(facts[5], undefined);
    assert.ok(facts[6]);
    assert.match(facts[6].text, /7/);
  });

  it('a re-delivered part for the same call is not counted twice', () => {
    const decorate = createDeployedProgressFacts();
    decorate(searchPart({ state: 'output-available', callId: 'call-x' }));
    const again = decorate(searchPart({ state: 'output-available', callId: 'call-x' }));
    assert.strictEqual(again.progress, undefined);
  });

  it('stays silent for searches still running', () => {
    const decorate = createDeployedProgressFacts();
    assert.strictEqual(decorate(searchPart({ state: 'input-streaming' })).progress, undefined);
  });
});
