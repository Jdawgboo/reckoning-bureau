import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FirecrawlSessionTool } from './firecrawl-session.tool.ts';
import type { ToolExecuteContext } from '../../agent/agent-library.ts';

const BASE = 'https://platform.test';
const KEY = 'access-key-abc';

function makeCtx(): ToolExecuteContext {
  return {
    runner: { state: { getApp: () => null } } as ToolExecuteContext['runner'],
    abortSignal: undefined,
    toolCallId: 'test-1',
  };
}

type FetchCall = { url: string; init?: RequestInit };
let originalFetch: typeof fetch;
let calls: FetchCall[];

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler({ url, init });
  };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (h && typeof h === 'object' && !Array.isArray(h)) {
    const value = (h as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

describe('FirecrawlSessionTool', () => {
  const tool = new FirecrawlSessionTool({ apiBaseUrl: BASE, accessKey: KEY });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('open posts to /session with the access key and returns the sessionId', async () => {
    installFetch(() => new Response(JSON.stringify({ sessionId: 'sess-1' }), { status: 200 }));

    const result = await tool.execute(
      { action: 'open', url: 'https://x/lot', profile: 'p' },
      makeCtx(),
    );

    assert.equal(calls[0]?.url, `${BASE}/platform-services/firecrawl/session`);
    assert.equal(header(calls[0]?.init, 'x-access-key'), KEY);
    assert.match(String(result.output), /sess-1/);
  });

  it('open maps 402 to an out-of-credits message', async () => {
    installFetch(
      () => new Response(JSON.stringify({ error: 'insufficient_credits' }), { status: 402 }),
    );

    const result = await tool.execute({ action: 'open', url: 'https://x' }, makeCtx());

    assert.match(String(result.output), /Out of credits/);
  });

  it('interact posts code and surfaces the live-view url', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ success: true, result: 'OK', interactiveLiveViewUrl: 'https://live/i' }),
          { status: 200 },
        ),
    );

    const result = await tool.execute(
      { action: 'interact', sessionId: 'sess-1', code: 'page.title()' },
      makeCtx(),
    );

    assert.equal(calls[0]?.url, `${BASE}/platform-services/firecrawl/session/sess-1/interact`);
    assert.match(String(result.output), /OK/);
    assert.match(String(result.output), /https:\/\/live\/i/);
  });

  it('interact maps 410 to a re-open hint', async () => {
    installFetch(() => new Response(JSON.stringify({ error: 'session_expired' }), { status: 410 }));

    const result = await tool.execute(
      { action: 'interact', sessionId: 'gone', code: 'x' },
      makeCtx(),
    );

    assert.match(String(result.output), /expired/i);
  });

  it('scrape returns the page content', async () => {
    installFetch(
      () => new Response(JSON.stringify({ content: '<html>lot</html>' }), { status: 200 }),
    );

    const result = await tool.execute(
      { action: 'scrape', sessionId: 'sess-1', url: 'https://x/lot?id=9' },
      makeCtx(),
    );

    assert.equal(calls[0]?.url, `${BASE}/platform-services/firecrawl/session/sess-1/scrape`);
    assert.equal(result.output, '<html>lot</html>');
  });

  it('close sends DELETE and confirms', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ sessionDurationMs: 1, creditsBilled: 2 }), { status: 200 }),
    );

    const result = await tool.execute({ action: 'close', sessionId: 'sess-1' }, makeCtx());

    assert.equal(calls[0]?.url, `${BASE}/platform-services/firecrawl/session/sess-1`);
    assert.equal(calls[0]?.init?.method, 'DELETE');
    assert.match(String(result.output), /closed/i);
  });

  it('validates required fields per action without calling the platform', async () => {
    let called = false;
    installFetch(() => {
      called = true;
      return new Response('{}', { status: 200 });
    });

    const result = await tool.execute({ action: 'interact', sessionId: 'sess-1' }, makeCtx());

    assert.match(String(result.output), /requires/);
    assert.equal(called, false);
  });
});
