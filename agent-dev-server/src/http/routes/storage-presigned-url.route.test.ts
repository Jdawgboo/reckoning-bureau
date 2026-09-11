import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createStoragePresignedUrlRoute } from './storage-presigned-url.route.ts';
import type { DependencyContainer } from '../../container.ts';

type FetchCall = { url: string; init: RequestInit | undefined };

function installFetchStub(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeContainer(apiBaseUrl = 'https://platform.test', accessKey = 'KEY-1') {
  return {
    getAgentStorageFactoryService() {
      return {
        getApiBaseUrl: () => apiBaseUrl,
        getAccessKey: () => accessKey,
      };
    },
  } as unknown as DependencyContainer;
}

function makeReq(pathAndQuery: string, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([]) as IncomingMessage, {
    method: 'GET',
    url: pathAndQuery,
    headers: { host: 'localhost', ...headers },
  }) as IncomingMessage;
}

type CapturedRes = {
  res: ServerResponse;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function makeRes(): CapturedRes {
  const captured: CapturedRes = {
    res: undefined as unknown as ServerResponse,
    statusCode: 0,
    headers: {},
    body: '',
  };
  const res = {
    writeHead(status: number, hdrs?: Record<string, string>) {
      captured.statusCode = status;
      if (hdrs) Object.assign(captured.headers, hdrs);
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
    },
  } as unknown as ServerResponse;
  captured.res = res;
  return captured;
}

describe('createStoragePresignedUrlRoute', () => {
  let stub: ReturnType<typeof installFetchStub> | undefined;
  afterEach(() => stub?.restore());

  it('matches GET /api/storage/presigned-url and its querystring variant', () => {
    const route = createStoragePresignedUrlRoute(makeContainer());
    assert.strictEqual(route.matches('GET', '/api/storage/presigned-url'), true);
    assert.strictEqual(route.matches('GET', '/api/storage/presigned-url?path=foo'), true);
    assert.strictEqual(route.matches('POST', '/api/storage/presigned-url'), false);
    assert.strictEqual(route.matches('GET', '/api/storage/download'), false);
  });

  it('returns 400 when path is missing', async () => {
    stub = installFetchStub(async () => new Response('{}', { status: 200 }));
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url'), captured.res);
    assert.strictEqual(captured.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(captured.body), {
      error: 'path query parameter is required',
    });
  });

  it('returns 400 when path is only whitespace', async () => {
    stub = installFetchStub(async () => new Response('{}', { status: 200 }));
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url?path=%20%20'), captured.res);
    assert.strictEqual(captured.statusCode, 400);
  });

  it('forwards session-id header to platform as the location query', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'https://s3', expiresAt: 1 }), {
          status: 200,
        }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(
      makeReq('/api/storage/presigned-url?path=foo.pdf', {
        'x-agentplace-session-id': 'session-xyz',
      }),
      captured.res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('path'), 'foo.pdf');
    assert.strictEqual(sent.searchParams.get('location'), 'session-xyz');
    assert.strictEqual(sent.searchParams.get('disposition'), 'attachment');
    assert.strictEqual(captured.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(captured.body), { url: 'https://s3', expiresAt: 1 });
  });

  it('routes a common/ path to location=common and strips the branch prefix', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(
      makeReq('/api/storage/presigned-url?path=common/report.pdf', {
        'x-agentplace-session-id': 'session-xyz',
      }),
      makeRes().res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), 'common');
    assert.strictEqual(sent.searchParams.get('path'), 'report.pdf');
  });

  it('routes a private/ path to the session location and strips the branch prefix', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(
      makeReq('/api/storage/presigned-url?path=private/report.pdf', {
        'x-agentplace-session-id': 'session-xyz',
      }),
      makeRes().res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), 'session-xyz');
    assert.strictEqual(sent.searchParams.get('path'), 'report.pdf');
  });

  it('keeps a nested in-session common path via the explicit private/ prefix', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(
      makeReq('/api/storage/presigned-url?path=private/common/report.pdf', {
        'x-agentplace-session-id': 'session-xyz',
      }),
      makeRes().res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), 'session-xyz');
    assert.strictEqual(sent.searchParams.get('path'), 'common/report.pdf');
  });

  it('preserves nested paths under a common/ branch', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(
      makeReq('/api/storage/presigned-url?path=common/sub/dir/file.csv'),
      makeRes().res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), 'common');
    assert.strictEqual(sent.searchParams.get('path'), 'sub/dir/file.csv');
  });

  it('echoes the original (pre-strip) path in the 404 message', async () => {
    stub = installFetchStub(async () => new Response('not found', { status: 404 }));
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url?path=common/gone.pdf'), captured.res);
    assert.strictEqual(captured.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(captured.body), { error: 'file not found: common/gone.pdf' });
  });

  it('omits location query when session header missing (common-storage lookup)', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(makeReq('/api/storage/presigned-url?path=foo.pdf'), makeRes().res);
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), null);
  });

  it('passes disposition=inline through to platform when explicitly requested', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    await route.handler(
      makeReq('/api/storage/presigned-url?path=pic.png&disposition=inline'),
      makeRes().res,
    );
    const sent = new URL(stub!.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('disposition'), 'inline');
  });

  it('sends x-access-key header from the storage factory', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer('https://api.test', 'SECRET-KEY'));
    await route.handler(makeReq('/api/storage/presigned-url?path=x.bin'), makeRes().res);
    const headers = stub!.calls[0]!.init?.headers as Record<string, string>;
    assert.strictEqual(headers['x-access-key'], 'SECRET-KEY');
  });

  it('returns 404 when platform-server reports the file is missing', async () => {
    stub = installFetchStub(async () => new Response('not found', { status: 404 }));
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url?path=gone.pdf'), captured.res);
    assert.strictEqual(captured.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(captured.body), { error: 'file not found: gone.pdf' });
  });

  it('forwards 409 (compressed file) with code=compressed', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: false, error: 'compressed', code: 'compressed' }), {
          status: 409,
        }),
    );
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url?path=big.pdf'), captured.res);
    assert.strictEqual(captured.statusCode, 409);
    const body = JSON.parse(captured.body) as { code: string };
    assert.strictEqual(body.code, 'compressed');
  });

  it('returns 500 with a generic error on platform 5xx (no upstream detail leak)', async () => {
    stub = installFetchStub(async () => new Response('upstream boom', { status: 503 }));
    const route = createStoragePresignedUrlRoute(makeContainer());
    const captured = makeRes();
    await route.handler(makeReq('/api/storage/presigned-url?path=x.pdf'), captured.res);
    assert.strictEqual(captured.statusCode, 500);
    const body = JSON.parse(captured.body) as { error: string };
    // Generic message only — do NOT echo upstream details (URLs, statuses, AWS
    // signatures, etc.) to the browser.
    assert.strictEqual(body.error, 'failed to mint presigned URL');
    assert.ok(!body.error.includes('HTTP 503'));
    assert.ok(!body.error.includes('boom'));
  });
});
