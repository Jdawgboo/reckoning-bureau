import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { fetchPresignedDownloadUrl } from './platform-storage-client.ts';

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

describe('fetchPresignedDownloadUrl', () => {
  let stub: ReturnType<typeof installFetchStub>;

  afterEach(() => {
    stub?.restore();
  });

  it('builds the correct URL with path + disposition + optional location and sends x-access-key', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'https://signed', expiresAt: 999 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const result = await fetchPresignedDownloadUrl({
      apiBaseUrl: 'https://api.example.io/',
      accessKey: 'KEY-1',
      filePath: 'dir/file.pdf',
      location: 'session-abc',
      disposition: 'inline',
    });

    assert.strictEqual(stub.calls.length, 1);
    const sent = new URL(stub.calls[0]!.url);
    // Trailing slash on apiBaseUrl is stripped.
    assert.strictEqual(sent.origin + sent.pathname, 'https://api.example.io/storage/presigned-url');
    assert.strictEqual(sent.searchParams.get('path'), 'dir/file.pdf');
    assert.strictEqual(sent.searchParams.get('disposition'), 'inline');
    assert.strictEqual(sent.searchParams.get('location'), 'session-abc');

    const headers = stub.calls[0]!.init?.headers as Record<string, string>;
    assert.strictEqual(headers['x-access-key'], 'KEY-1');

    assert.deepStrictEqual(result, { url: 'https://signed', expiresAt: 999 });
  });

  it('omits the location query when not provided', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: true, url: 'u', expiresAt: 1 }), { status: 200 }),
    );
    await fetchPresignedDownloadUrl({
      apiBaseUrl: 'https://api.example.io',
      accessKey: 'k',
      filePath: 'file.bin',
      disposition: 'attachment',
    });
    const sent = new URL(stub.calls[0]!.url);
    assert.strictEqual(sent.searchParams.get('location'), null);
  });

  it('returns { reason: not-found } on 404', async () => {
    stub = installFetchStub(async () => new Response('not found', { status: 404 }));
    const result = await fetchPresignedDownloadUrl({
      apiBaseUrl: 'https://api.example.io',
      accessKey: 'k',
      filePath: 'gone.pdf',
      disposition: 'attachment',
    });
    assert.deepStrictEqual(result, { reason: 'not-found' });
  });

  it('returns { reason: compressed } on 409', async () => {
    stub = installFetchStub(
      async () =>
        new Response(JSON.stringify({ success: false, error: 'compressed', code: 'compressed' }), {
          status: 409,
        }),
    );
    const result = await fetchPresignedDownloadUrl({
      apiBaseUrl: 'https://api.example.io',
      accessKey: 'k',
      filePath: 'big.pdf',
      disposition: 'attachment',
    });
    assert.deepStrictEqual(result, { reason: 'compressed' });
  });

  it('throws on 200 with malformed body (missing url or success flag)', async () => {
    stub = installFetchStub(
      async () => new Response(JSON.stringify({ success: false, error: 'oops' }), { status: 200 }),
    );
    await assert.rejects(
      () =>
        fetchPresignedDownloadUrl({
          apiBaseUrl: 'https://api.example.io',
          accessKey: 'k',
          filePath: 'x.pdf',
          disposition: 'attachment',
        }),
      (err) => err instanceof Error && err.message.includes('malformed payload'),
    );
  });

  it('throws on 5xx with the body in the message', async () => {
    stub = installFetchStub(
      async () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
    );
    await assert.rejects(
      () =>
        fetchPresignedDownloadUrl({
          apiBaseUrl: 'https://api.example.io',
          accessKey: 'k',
          filePath: 'x.pdf',
          disposition: 'attachment',
        }),
      (err) =>
        err instanceof Error && err.message.includes('HTTP 503') && err.message.includes('boom'),
    );
  });
});
