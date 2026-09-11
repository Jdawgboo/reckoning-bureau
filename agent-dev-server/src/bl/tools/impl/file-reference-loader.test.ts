import { describe, test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FileReferenceLoader, type LoadedFile, type LoadError } from './file-reference-loader.ts';

type FetchCall = { url: string; init?: RequestInit };

let originalFetch: typeof fetch;
let fetchCalls: FetchCall[];

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  fetchCalls = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return handler({ url, init });
  };
}

function bodyResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
  });
}

function isError(r: LoadedFile | LoadError): r is LoadError {
  return 'error' in r;
}

describe('FileReferenceLoader', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('https', () => {
    test('happy path → bytes + filename from path + mediaType from content-type', async () => {
      const loader = new FileReferenceLoader();
      installFetch(() => bodyResponse(new Uint8Array([1, 2, 3]), 'application/pdf'));
      const r = await loader.load('https://example.io/dir/doc.pdf', {});
      assert.ok(!isError(r));
      assert.equal(r.filename, 'doc.pdf');
      assert.equal(r.mediaType, 'application/pdf');
      assert.deepEqual([...r.bytes], [1, 2, 3]);
    });

    test('content-type with charset is normalised to the bare media type', async () => {
      const loader = new FileReferenceLoader();
      installFetch(() => bodyResponse(new Uint8Array([1]), 'text/plain; charset=utf-8'));
      const r = await loader.load('https://example.io/notes.txt', {});
      assert.ok(!isError(r));
      assert.equal(r.mediaType, 'text/plain');
    });

    test('missing content-type falls back to extension sniffing', async () => {
      const loader = new FileReferenceLoader();
      installFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
      const r = await loader.load('https://example.io/photo.png', {});
      assert.ok(!isError(r));
      assert.equal(r.mediaType, 'image/png');
    });

    test('HEAD 405 → falls through to streaming the body', async () => {
      const loader = new FileReferenceLoader();
      installFetch((call) => {
        if (call.init?.method === 'HEAD') return new Response(null, { status: 405 });
        return bodyResponse(new Uint8Array([1, 2]), 'image/png');
      });
      const r = await loader.load('https://cdn.example.io/p.png', {});
      assert.ok(!isError(r), 'must load despite HEAD 405');
    });

    test('HEAD content-length over cap → error before fetching the body', async () => {
      const loader = new FileReferenceLoader();
      installFetch((call) => {
        if (call.init?.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-length': String(6 * 1024 * 1024) },
          });
        }
        return bodyResponse(new Uint8Array([1]), 'application/pdf');
      });
      const r = await loader.load('https://example.io/big.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /HEAD reports body > 5 MB cap/);
      assert.ok(
        !fetchCalls.some((c) => c.init?.method !== 'HEAD'),
        'body must not be fetched once HEAD reports too-large',
      );
    });

    test('streaming body over cap (no HEAD content-length) → error', async () => {
      const loader = new FileReferenceLoader();
      const big = new Uint8Array(5 * 1024 * 1024 + 10);
      installFetch((call) => {
        if (call.init?.method === 'HEAD') return new Response(null, { status: 405 });
        return new Response(big, { status: 200, headers: { 'content-type': 'application/pdf' } });
      });
      const r = await loader.load('https://example.io/stream.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /body exceeded 5 MB cap/);
    });

    test('empty body → error', async () => {
      const loader = new FileReferenceLoader();
      installFetch(
        () => new Response('', { status: 200, headers: { 'content-type': 'image/png' } }),
      );
      const r = await loader.load('https://example.io/empty.png', {});
      assert.ok(isError(r));
      assert.match(r.error, /empty response body/);
    });

    test('non-2xx response → HTTP status error', async () => {
      const loader = new FileReferenceLoader();
      installFetch((call) => {
        if (call.init?.method === 'HEAD') return new Response(null, { status: 405 });
        return new Response('nope', { status: 404 });
      });
      const r = await loader.load('https://example.io/missing.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /HTTP 404/);
    });

    test('invalid URL → error', async () => {
      const loader = new FileReferenceLoader();
      const r = await loader.load('https://[not a url', {});
      assert.ok(isError(r));
      assert.match(r.error, /invalid URL/);
    });

    test('non-https scheme → error', async () => {
      const loader = new FileReferenceLoader();
      const r = await loader.load('http://example.io/p.png', {});
      assert.ok(isError(r));
      assert.match(r.error, /must use https/);
    });
  });

  describe('agent-storage', () => {
    test('no storage factory configured → error', async () => {
      const loader = new FileReferenceLoader();
      const r = await loader.load('agent-storage:report.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /storage factory/);
    });

    test('missing path after scheme → error', async () => {
      const loader = new FileReferenceLoader({
        storageFactory: { getStorage: () => ({ readFile: async () => Buffer.from('x') }) },
      });
      const r = await loader.load('agent-storage:', {});
      assert.ok(isError(r));
      assert.match(r.error, /missing the path/);
    });

    test('happy path → bytes + basename filename + mediaType from extension', async () => {
      const loader = new FileReferenceLoader({
        storageFactory: { getStorage: () => ({ readFile: async () => Buffer.from('hello') }) },
      });
      const r = await loader.load('agent-storage:nested/doc.pdf', {});
      assert.ok(!isError(r));
      assert.equal(r.filename, 'doc.pdf');
      assert.equal(r.mediaType, 'application/pdf');
      assert.equal(r.bytes.toString(), 'hello');
    });

    test('passes the session secretFolder through to getStorage', async () => {
      const calls: Array<string | undefined> = [];
      const loader = new FileReferenceLoader({
        storageFactory: {
          getStorage(secretFolder?: string) {
            calls.push(secretFolder);
            return { readFile: async () => Buffer.from('x') };
          },
        },
      });
      await loader.load('agent-storage:doc.pdf', { secretFolder: 'sess-42' });
      assert.deepEqual(calls, ['sess-42']);
    });

    test('buffer over cap → error', async () => {
      const loader = new FileReferenceLoader({
        storageFactory: {
          getStorage: () => ({ readFile: async () => Buffer.alloc(6 * 1024 * 1024) }),
        },
      });
      const r = await loader.load('agent-storage:big.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /exceeds 5 MB cap/);
    });

    test('storage read throwing → wrapped error', async () => {
      const loader = new FileReferenceLoader({
        storageFactory: {
          getStorage: () => ({
            readFile: async () => {
              throw new Error('boom');
            },
          }),
        },
      });
      const r = await loader.load('agent-storage:doc.pdf', {});
      assert.ok(isError(r));
      assert.match(r.error, /storage read failed: boom/);
    });
  });
});
