import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import { ToolCall, type ToolInvocationContext } from '../../agent/agent-library.ts';
import { VertexUrlContextTool } from './vertex-url-context.tool.ts';

// Minimal stub: the constructor only needs `provider.tools.urlContext({})` to
// return *something* it can store. GoogleVertexProvider is a large multi-method
// type — `as unknown as` is the standard test-stub escape hatch in this repo
// (deep-research-tool.model.test.ts:51 does the same).
function makeFakeProvider(toolDescriptor: unknown): GoogleVertexProvider {
  return {
    tools: {
      urlContext: (_input: unknown) => toolDescriptor,
    },
  } as unknown as GoogleVertexProvider;
}

describe('VertexUrlContextTool', () => {
  test('exposes the wire-name `url_context` on `name`', () => {
    const descriptor = { type: 'provider-defined' };
    const tool = new VertexUrlContextTool({ provider: makeFakeProvider(descriptor) });
    // AI SDK requires this exact name for Vertex urlContext — see
    // @ai-sdk/google/dist/index.d.ts ("Must have name `url_context`").
    assert.equal(tool.name, 'url_context');
  });

  test('toolType is not `function` so the tool-loop runner skips local execution', () => {
    const tool = new VertexUrlContextTool({ provider: makeFakeProvider({}) });
    // The durable invariant — `tool-loop-agent.tools.ts` only checks
    // `kind !== 'function'`. The current value happens to be 'web_search'
    // (under-the-hood reuse of the closed ToolType union), but that exact
    // string is incidental to the routing behavior.
    assert.notEqual(tool.getToolType(), 'function');
  });

  test('getAiSdkTool returns the descriptor produced by provider.tools.urlContext, stable across calls', () => {
    const descriptor = { type: 'provider-defined', id: 'google.url_context' };
    const tool = new VertexUrlContextTool({ provider: makeFakeProvider(descriptor) });
    const first = tool.getAiSdkTool();
    const second = tool.getAiSdkTool();
    assert.ok(first, 'getAiSdkTool() must return a non-null descriptor');
    assert.equal(
      first,
      second,
      'descriptor instance must be stable (no re-construction per access)',
    );
  });

  test('call() is a no-op (returns null) — provider-native tools never run locally', async () => {
    const tool = new VertexUrlContextTool({ provider: makeFakeProvider({}) });
    // The base ToolModel.call() throws by default to catch tools that forgot to
    // migrate to execute(). Provider-native tools override it to return null
    // explicitly; the call should NEVER actually be invoked by the kernel
    // because getAiSdkTool() returns non-null. ToolInvocationContext is a
    // structural type — the no-op call() ignores it, so `{}` cast is enough.
    const toolCall = new ToolCall<Record<string, never>>({
      id: 'tc-1',
      name: 'url_context',
      parsedArgs: {},
    });
    const result = await tool.call(
      toolCall,
      { append: () => {} },
      {} as unknown as ToolInvocationContext<unknown>,
    );
    assert.equal(result, null);
  });
});
