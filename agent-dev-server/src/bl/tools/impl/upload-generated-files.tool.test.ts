import { describe, test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  UploadGeneratedFilesTool,
  type UploadGeneratedFilesToolConfig,
} from './upload-generated-files.tool.ts';
import { PendingFilesRegistry } from './pending-files-registry.ts';
import type { ToolExecuteContext } from '../../agent/agent-library.ts';

type FetchCall = { url: string; init?: RequestInit };
type WriteCall = { filename: string; bytes: Uint8Array; secretFolder?: string };
type FakeStorageFactory = UploadGeneratedFilesToolConfig['storageFactory'];

function fakeStorageFactory(opts?: { failOn?: string }): {
  factory: FakeStorageFactory;
  calls: WriteCall[];
  getStorageCalls: Array<string | undefined>;
} {
  const calls: WriteCall[] = [];
  const getStorageCalls: Array<string | undefined> = [];
  return {
    calls,
    getStorageCalls,
    factory: {
      getStorage(secretFolder?: string) {
        getStorageCalls.push(secretFolder);
        return {
          async writeFile(filename: string, content: Buffer) {
            if (opts?.failOn && filename === opts.failOn) {
              throw new Error('storage write failed');
            }
            calls.push({ filename, bytes: new Uint8Array(content), secretFolder });
            return { adapter: secretFolder ? 'private' : 'common', path: filename };
          },
        };
      },
    },
  };
}

/**
 * The tool reads `getSessionKey(ctx.runner.state)` so its writes target the
 * caller's session-scoped storage. `getSessionKey` walks
 * `state.getApp().context.getSessionKey()`, so the fake exposes exactly that
 * shape and nothing more. Without `opts.sessionKey` the chain short-circuits
 * to `undefined` and the storage factory falls back to `common/`.
 */
function makeCtx(opts?: { sessionKey?: string }): ToolExecuteContext {
  const app = opts?.sessionKey ? { context: { getSessionKey: () => opts.sessionKey } } : null;
  return {
    runner: {
      state: { getApp: () => app },
    } as ToolExecuteContext['runner'],
    abortSignal: undefined,
    toolCallId: 'test-1',
  };
}

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

function metadataResponse(filename: string, mimeType: string): Response {
  return new Response(JSON.stringify({ filename, mime_type: mimeType }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTool(args: {
  registry: PendingFilesRegistry;
  storageFactory: FakeStorageFactory;
}): UploadGeneratedFilesTool {
  return new UploadGeneratedFilesTool({
    registry: args.registry,
    storageFactory: args.storageFactory,
    gatewayBaseUrl: 'https://platform.example.com/api/gateway',
    accessKey: 'test-access-key',
  });
}

describe('UploadGeneratedFilesTool', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('happy path: drains pending registry, downloads, writes, deletes, marks processed', async () => {
    const registry = new PendingFilesRegistry();
    registry.markPending('file_A');
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    installFetch((call) => {
      if (call.init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (call.url.endsWith('/content')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }
      return metadataResponse(
        'solar.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
    });

    const result = await tool.execute({}, makeCtx({ sessionKey: 'sess-abc' }));
    const output = result.output as string;

    assert.match(output, /Saved 1\/1 file\(s\) to agent storage\./);
    assert.match(output, /- solar\.pptx \(application\/vnd\.openxmlformats/);

    assert.equal(storage.calls.length, 1);
    assert.equal(storage.calls[0].filename, 'solar.pptx');
    assert.equal(storage.calls[0].bytes.length, 4);
    // Session key is plumbed through: factory must be asked for the
    // session-scoped storage so the write lands in `private/<sessionKey>/`.
    assert.equal(storage.calls[0].secretFolder, 'sess-abc');
    assert.deepStrictEqual(storage.getStorageCalls, ['sess-abc']);
    assert.deepStrictEqual(registry.listPending(), [], 'registry drained');

    // Best-effort DELETE flushes after the tool returns
    await new Promise((resolve) => setImmediate(resolve));
    const deleteCall = fetchCalls.find((c) => c.init?.method === 'DELETE');
    assert.ok(deleteCall, 'DELETE should be issued');
    assert.match(deleteCall.url, /\/anthropic\/v1\/files\/file_A$/);
  });

  test('no session key in context: falls back to default storage (common adapter)', async () => {
    const registry = new PendingFilesRegistry();
    registry.markPending('file_A');
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    installFetch((call) => {
      if (call.init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (call.url.endsWith('/content')) return new Response(new Uint8Array([1]), { status: 200 });
      return metadataResponse('a.pdf', 'application/pdf');
    });

    await tool.execute({}, makeCtx());

    assert.equal(storage.calls.length, 1);
    assert.equal(
      storage.calls[0].secretFolder,
      undefined,
      'no session key → factory is called with undefined so `common/` handles the write',
    );
  });

  test('empty pending registry: returns hint without any fetch / writeFile', async () => {
    const registry = new PendingFilesRegistry();
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    let fetched = 0;
    installFetch(() => {
      fetched++;
      return new Response(null, { status: 200 });
    });

    const result = await tool.execute({}, makeCtx());
    assert.match(result.output as string, /No new files to upload/);
    assert.equal(fetched, 0);
    assert.equal(storage.calls.length, 0);
  });

  test('idempotent: second call after success has nothing to do', async () => {
    const registry = new PendingFilesRegistry();
    registry.markPending('file_A');
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    installFetch((call) => {
      if (call.init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (call.url.endsWith('/content')) return new Response(new Uint8Array([1]), { status: 200 });
      return metadataResponse('chart.png', 'image/png');
    });

    await tool.execute({}, makeCtx());
    // Reset fetch tracking for the second call
    fetchCalls = [];

    const second = await tool.execute({}, makeCtx());
    assert.match(second.output as string, /No new files to upload/);
    assert.equal(fetchCalls.length, 0, 'second call must not hit the network');
    assert.equal(storage.calls.length, 1, 'writeFile not re-invoked');
  });

  test('partial failure: surviving file_ids succeed, failed one is named in the output', async () => {
    const registry = new PendingFilesRegistry();
    registry.markPending('file_OK');
    registry.markPending('file_GONE');
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    installFetch((call) => {
      if (call.init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (call.url.includes('file_GONE')) {
        return new Response('not found', { status: 404 });
      }
      if (call.url.endsWith('/content')) return new Response(new Uint8Array([9]), { status: 200 });
      return metadataResponse('a.pdf', 'application/pdf');
    });

    const result = await tool.execute({}, makeCtx());
    const output = result.output as string;

    assert.match(output, /Saved 1\/2 file\(s\)/);
    assert.match(output, /- a\.pdf \(application\/pdf\)/);
    assert.match(output, /- file_id file_GONE: metadata HTTP 404/);
    assert.equal(storage.calls.length, 1);
    // Both ids are marked processed even though one failed — the registry
    // outlives a single subagent run (it's constructed once in
    // `createCodeExecutorSubagent`), so leaving the failure as `pending`
    // would let it resurface on the next Subagent call and either re-report
    // the same 404 or, if Anthropic still has the file, download bytes from
    // a previous task into the current session's storage. The failure is
    // reported in the output text instead.
    assert.deepStrictEqual(
      registry.listPending(),
      [],
      'every attempted id is marked processed regardless of per-id outcome',
    );
  });

  test('pre-aborted signal returns Canceled before any fetch', async () => {
    const registry = new PendingFilesRegistry();
    registry.markPending('file_A');
    const storage = fakeStorageFactory();
    const tool = makeTool({ registry, storageFactory: storage.factory });

    let fetched = 0;
    installFetch(() => {
      fetched++;
      return new Response(null, { status: 200 });
    });

    const aborted = new AbortController();
    aborted.abort();
    const ctx: ToolExecuteContext = {
      runner: {} as ToolExecuteContext['runner'],
      abortSignal: aborted.signal,
      toolCallId: 'test-1',
    };

    const result = await tool.execute({}, ctx);
    assert.equal(result.output, 'Canceled.');
    assert.equal(fetched, 0);
    assert.equal(storage.calls.length, 0);
  });
});
