import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FirecrawlScrapeTool } from './firecrawl-scrape.tool.ts';
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

describe('FirecrawlScrapeTool', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the platform endpoint with x-access-key and returns the markdown on 200', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ markdown: '# Page' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const tool = new FirecrawlScrapeTool({ apiBaseUrl: BASE, accessKey: KEY });

    const result = await tool.execute({ url: 'https://example.com' }, makeCtx());

    assert.equal(result.output, '# Page');
    assert.equal(calls[0]?.url, `${BASE}/platform-services/firecrawl/scrape`);
    assert.equal(header(calls[0]?.init, 'x-access-key'), KEY);
  });

  it('returns an upsell message on 403 (not purchased)', async () => {
    installFetch(() => new Response(JSON.stringify({ error: 'not_purchased' }), { status: 403 }));
    const tool = new FirecrawlScrapeTool({ apiBaseUrl: BASE, accessKey: KEY });

    const result = await tool.execute({ url: 'https://example.com' }, makeCtx());

    assert.match(String(result.output), /needs the Firecrawl service/);
  });

  it('returns a failure message on other non-ok statuses', async () => {
    installFetch(() => new Response('boom', { status: 500 }));
    const tool = new FirecrawlScrapeTool({ apiBaseUrl: BASE, accessKey: KEY });

    const result = await tool.execute({ url: 'https://example.com' }, makeCtx());

    assert.match(String(result.output), /Scrape failed \(500\)/);
  });
});
