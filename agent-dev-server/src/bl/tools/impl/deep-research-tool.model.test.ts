import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DeepResearchToolModel } from './deep-research-tool.model.ts';
import {
  ContentType,
  type AgentContent,
  type AgentFactory,
  type ToolExecuteContext,
} from '../../agent/agent-library.ts';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { UserFacingProgress } from '../../agent/agent-library.ts';

// AGE-170 regression coverage.
//
// DeepWebSearchTool is a plain ToolModel (no getComponentName override), so the
// kernel emits ContentType.Tool events for it — not ContentType.Component. The
// research tool reads the search query from `streaming.input.query` at
// `input-available` and the source list from `content.sources` at
// `output-available`. Without these tests, a future refactor of the event
// channel would silently regress the source-count chip back to 0.

/**
 * AgentFactory whose create() returns a handle whose content stream replays a
 * fixed list of AgentContent items. The double cast is unavoidable because
 * AgentFactory is a class with private fields; the deep-research tool only
 * reaches `.create().runHandle()`, which the mock implements.
 */
function replayingAgentFactory(contents: AgentContent[]): AgentFactory {
  const fakeHandle = {
    stream: (async function* () {
      for (const c of contents) {
        yield c;
      }
    })(),
    events: (async function* () {})(),
    done: Promise.resolve({ status: 'ok' as const, stopReason: 'end-turn' as const }),
  };
  return {
    create: () => ({
      runHandle: async () => fakeHandle,
    }),
  } as unknown as AgentFactory;
}

/**
 * The deep-research tool calls `provider(modelId)` once to build the child
 * agent's model, and passes the provider to DeepWebSearchTool. Both paths are
 * short-circuited by the mocked agent factory before any provider method runs,
 * so a callable stub is enough — but `GoogleVertexProvider` is a multi-method
 * interface, so the cast is unavoidable to satisfy its type.
 */
const fakeProvider = ((_modelId: string) => null) as unknown as GoogleVertexProvider;

/** One completed search over the tool's own event shape. */
function searchPair(call: string, query: string, urls: string[]): AgentContent[] {
  return [
    {
      type: ContentType.Tool,
      messageId: `${call}-in`,
      tool: { name: 'deep_web_search' },
      content: undefined,
      streaming: {
        toolName: 'deep_web_search',
        toolCallId: call,
        state: 'input-available',
        input: { query },
      },
    },
    {
      type: ContentType.Tool,
      messageId: `${call}-out`,
      tool: { name: 'deep_web_search' },
      content: {
        sources: urls.map((url) => ({ url, domain: 'example.com', title: url })),
      },
      streaming: { toolName: 'deep_web_search', toolCallId: call, state: 'output-available' },
    },
  ];
}

function makeCtx(
  onProgress?: (props: Record<string, unknown>, progress?: UserFacingProgress) => void,
): ToolExecuteContext {
  return {
    runner: { state: undefined },
    toolCallId: 'test-1',
    onProgress,
  };
}

describe('DeepResearchToolModel — source extraction', () => {
  it('extracts sources from ContentType.Tool output-available events', async () => {
    const factory = replayingAgentFactory([
      {
        type: ContentType.Tool,
        messageId: 'm1',
        tool: { name: 'deep_web_search' },
        content: undefined,
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_1',
          state: 'input-available',
          input: { query: 'history of typography' },
        },
      },
      {
        type: ContentType.Tool,
        messageId: 'm2',
        tool: { name: 'deep_web_search' },
        content: {
          sources: [
            { url: 'https://example.com/a', domain: 'example.com', title: 'A' },
            { url: 'https://example.com/b', domain: 'example.com', title: 'B' },
          ],
        },
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_1',
          state: 'output-available',
        },
      },
    ]);

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    const result = await tool.execute({ query: 'typography' }, makeCtx());

    const props = result.uiProps as Record<string, unknown>;
    assert.equal(props.searchCount, 1);
    assert.deepStrictEqual(props.searches, ['history of typography']);
    assert.deepStrictEqual(props.sources, [
      { url: 'https://example.com/a', domain: 'example.com', title: 'A' },
      { url: 'https://example.com/b', domain: 'example.com', title: 'B' },
    ]);
  });

  it('deduplicates sources across multiple searches', async () => {
    const factory = replayingAgentFactory([
      {
        type: ContentType.Tool,
        messageId: 'm1',
        tool: { name: 'deep_web_search' },
        content: undefined,
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_1',
          state: 'input-available',
          input: { query: 'q1' },
        },
      },
      {
        type: ContentType.Tool,
        messageId: 'm2',
        tool: { name: 'deep_web_search' },
        content: {
          sources: [{ url: 'https://example.com/x', domain: 'example.com', title: 'X' }],
        },
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_1',
          state: 'output-available',
        },
      },
      {
        type: ContentType.Tool,
        messageId: 'm3',
        tool: { name: 'deep_web_search' },
        content: undefined,
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_2',
          state: 'input-available',
          input: { query: 'q2' },
        },
      },
      {
        type: ContentType.Tool,
        messageId: 'm4',
        tool: { name: 'deep_web_search' },
        content: {
          sources: [
            { url: 'https://example.com/x', domain: 'example.com', title: 'X' },
            { url: 'https://example.com/y', domain: 'example.com', title: 'Y' },
          ],
        },
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_2',
          state: 'output-available',
        },
      },
    ]);

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    const result = await tool.execute({ query: 'q' }, makeCtx());

    const props = result.uiProps as Record<string, unknown>;
    assert.equal(props.searchCount, 2);
    assert.deepStrictEqual(props.searches, ['q1', 'q2']);
    const sources = props.sources as Array<{ url: string }>;
    assert.equal(sources.length, 2, 'duplicate https://example.com/x should be deduped');
    assert.deepStrictEqual(
      sources.map((s) => s.url),
      ['https://example.com/x', 'https://example.com/y'],
    );
  });

  it('publishes a bounded progress fact at search milestones, not on every update', async () => {
    const factory = replayingAgentFactory([
      ...searchPair('call_1', 'q1', ['https://example.com/a', 'https://example.com/b']),
      ...searchPair('call_2', 'q2', ['https://example.com/c']),
      ...searchPair('call_3', 'q3', ['https://example.com/d']),
      ...searchPair('call_4', 'q4', ['https://example.com/e']),
    ]);
    const facts: UserFacingProgress[] = [];

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    await tool.execute(
      { query: 'q' },
      makeCtx((_props, progress) => {
        if (progress) {
          facts.push(progress);
        }
      }),
    );

    assert.deepStrictEqual(facts, [
      { text: 'Checked 1 search and found 2 distinct sources.' },
      { text: 'Checked 4 searches and found 5 distinct sources.' },
    ]);
  });

  it('publishes no progress fact for a search that found nothing new', async () => {
    const factory = replayingAgentFactory([
      ...searchPair('call_1', 'q1', ['https://example.com/a']),
      ...searchPair('call_2', 'q2', ['https://example.com/a']),
      ...searchPair('call_3', 'q3', ['https://example.com/a']),
      ...searchPair('call_4', 'q4', ['https://example.com/a']),
    ]);
    const facts: UserFacingProgress[] = [];

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    await tool.execute(
      { query: 'q' },
      makeCtx((_props, progress) => {
        if (progress) {
          facts.push(progress);
        }
      }),
    );

    assert.deepStrictEqual(facts, [{ text: 'Checked 1 search and found 1 distinct source.' }]);
  });

  it('ignores Tool events for tools other than deep_web_search', async () => {
    const factory = replayingAgentFactory([
      {
        type: ContentType.Tool,
        messageId: 'm1',
        tool: { name: 'get_current_time' },
        content: { time: '2026-05-14T00:00:00Z' },
        streaming: {
          toolName: 'get_current_time',
          toolCallId: 'call_1',
          state: 'output-available',
        },
      },
    ]);

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    const result = await tool.execute({ query: 'q' }, makeCtx());

    const props = result.uiProps as Record<string, unknown>;
    assert.equal(props.searchCount, 0);
    assert.deepStrictEqual(props.searches, []);
    assert.deepStrictEqual(props.sources, []);
  });

  it('reports the current search via onProgress at input-available', async () => {
    const progressCalls: Array<Record<string, unknown>> = [];
    const factory = replayingAgentFactory([
      {
        type: ContentType.Tool,
        messageId: 'm1',
        tool: { name: 'deep_web_search' },
        content: undefined,
        streaming: {
          toolName: 'deep_web_search',
          toolCallId: 'call_1',
          state: 'input-available',
          input: { query: 'startup metrics' },
        },
      },
    ]);

    const tool = new DeepResearchToolModel({ agentFactory: factory, provider: fakeProvider });
    await tool.execute(
      { query: 'metrics' },
      makeCtx((props) => progressCalls.push(props)),
    );

    const withCurrent = progressCalls.find((p) => p.currentSearch === 'startup metrics');
    assert.ok(withCurrent, 'expected an onProgress call with currentSearch === "startup metrics"');
    assert.deepStrictEqual(withCurrent?.searches, ['startup metrics']);
  });
});
