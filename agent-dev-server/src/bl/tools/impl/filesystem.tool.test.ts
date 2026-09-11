import { describe, test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemTool } from './filesystem.tool.ts';
import { loadSkillsPrompt } from '../../messaging/skills-loader.ts';
import { AgentStorageFactoryService } from '../../../services/agent-storage-factory.service.ts';
import {
  StorageFileNotFoundError,
  StorageAdapterNotFoundError,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';

const webpFixture = fs.readFileSync(path.join(import.meta.dirname, '__fixtures__', 'tiny.webp'));

function text(result: ToolExecuteResult): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

type MultiOut = {
  type: 'multi-content';
  description: string;
  parts: Array<
    | { kind: 'text'; text: string }
    | { kind: 'image'; image: { data: Uint8Array; mediaType: string; filename?: string } }
  >;
};

function asMulti(output: unknown): MultiOut {
  assert.ok(output && typeof output === 'object' && (output as MultiOut).type === 'multi-content');
  return output as MultiOut;
}

function makeMinimalPdf(content: string): Buffer {
  const stream =
    content === '' ? '' : `BT /F1 12 Tf 50 700 Td (${content.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objs: string[] = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 5 0 R/Resources<</Font<</F1 4 0 R>>>>>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
  ];
  const head = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [0];
  let pos = head.length;
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pos);
    const o = `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    body += o;
    pos += o.length;
  }
  const xrefStart = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${offsets[i]!.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(head + body + xref + trailer, 'binary');
}

const BRANCH_ROUTING: Record<string, string> = {
  'private/': 'private',
  'common/': 'common',
  'source/': 'source',
  'tool-results/': 'tool-results',
  'logs/': 'logs',
};
const ADAPTER_ORDER = ['private', 'common', 'source', 'tool-results', 'logs', 'local'];

function makeStorage(opts?: {
  adapterFiles?: Record<string, string[]>;
  fileContents?: Record<string, string | Buffer>;
  writes?: Array<{ path: string; size: number; content: string }>;
}) {
  const adapterFiles = opts?.adapterFiles ?? {};
  const fileContents = opts?.fileContents ?? {};
  const sorted = Object.entries(BRANCH_ROUTING).sort(([a], [b]) => b.length - a.length);

  return {
    getAdapterNames: () => [...ADAPTER_ORDER],
    getDefaultAdapterName: () => null,
    getRoutingPrefix: (name: string) =>
      Object.entries(BRANCH_ROUTING).find(([, a]) => a === name)?.[0] ?? '',
    resolvePath(p: string) {
      for (const [prefix, adapter] of sorted) {
        if (p.startsWith(prefix)) {
          const stripped = p
            .slice(prefix.length)
            .replace(/^\.\//, '')
            .replace(/^\//, '')
            .replace(/\/$/, '');
          return { adapter, relativePath: stripped === '.' ? '' : stripped };
        }
      }
      throw new StorageAdapterNotFoundError(p);
    },
    async listFiles(names?: string[]) {
      const targets = names && names.length > 0 ? names : ADAPTER_ORDER;
      return targets.flatMap((a) =>
        (adapterFiles[a] ?? []).map((p) => ({
          path: p,
          size: 1,
          contentType: 'text/plain',
          adapter: a,
        })),
      );
    },
    async readFile(p: string) {
      const found = fileContents[p];
      if (found === undefined) {
        throw new StorageFileNotFoundError(p, ADAPTER_ORDER);
      }
      return Buffer.isBuffer(found) ? found : Buffer.from(found, 'utf8');
    },
    async writeFile(p: string, buf: Buffer) {
      opts?.writes?.push({ path: p, size: buf.length, content: buf.toString('utf8') });
      return { adapter: 'private', path: p };
    },
  };
}

function factoryFor(storage: ReturnType<typeof makeStorage>, calls?: Array<string | undefined>) {
  return {
    getStorage: (secretFolder?: string) => {
      calls?.push(secretFolder);
      return storage;
    },
  } as never;
}

function makeCtx(opts?: { sessionKey?: string; abortSignal?: AbortSignal }): ToolExecuteContext {
  const app = { context: { getSessionKey: () => opts?.sessionKey ?? 'session-1' } };
  return {
    runner: { state: { getApp: () => app } } as ToolExecuteContext['runner'],
    abortSignal: opts?.abortSignal,
    toolCallId: 'test-1',
  } as ToolExecuteContext;
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

function viewTool(opts?: Parameters<typeof makeStorage>[0]): FilesystemTool {
  return new FilesystemTool({ storageFactory: factoryFor(makeStorage(opts)) });
}

test('an autoloaded skill origin resolves a reference through the real source adapter', async (t) => {
  const originalCwd = process.cwd();
  const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), 'skill-reference-'));
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const sourceRoot = path.join(fixtureRoot, '.agent');
  const skillRoot = path.join(sourceRoot, 'skills', 'studio');
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: studio\ndescription: Studio policies.\nmetadata:\n  autoload: true\n---\nRead references/policies.md when needed.',
  );
  fs.writeFileSync(
    path.join(skillRoot, 'references', 'policies.md'),
    'Bikes are welcome upstairs.',
  );
  process.chdir(fixtureRoot);

  const skillPath = loadSkillsPrompt().match(/^Path: (.+)$/m)?.[1];
  assert.strictEqual(skillPath, 'source/skills/studio/SKILL.md');
  const referencePath = path.posix.join(path.posix.dirname(skillPath), 'references/policies.md');
  const storageFactory = new AgentStorageFactoryService({
    apiBaseUrl: 'https://api.example.invalid',
    modelAccessToken: 'test-only',
  });
  storageFactory.setInfraConfig([{ name: 'source', basePath: sourceRoot }], {
    'source/': 'source',
  });
  const tool = new FilesystemTool({ storageFactory });

  const result = text(await tool.execute({ command: 'view', path: referencePath }, makeCtx()));

  assert.match(result, /read successfully/);
  assert.ok(result.includes('Bikes are welcome upstairs.'));
});

describe('FilesystemTool view — text file', () => {
  test('skips offload so reads are never re-stored', () => {
    assert.equal(viewTool().skipOffload, true);
  });

  test('reads an explicit 1-based line range', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': lines(10) } });
    const result = await tool.execute(
      { command: 'view', path: 'x.txt', view_range: [2, 4] },
      makeCtx(),
    );
    assert.match(text(result), /\(lines 2-4 of 10\)/);
    assert.ok(text(result).includes('line 2\nline 3\nline 4'));
    assert.ok(!text(result).includes('line 5'));
  });

  test('end -1 reads to end of file', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': lines(10) } });
    const result = await tool.execute(
      { command: 'view', path: 'x.txt', view_range: [8, -1] },
      makeCtx(),
    );
    assert.match(text(result), /\(lines 8-10 of 10\)/);
    assert.ok(text(result).includes('line 8\nline 9\nline 10'));
  });

  test('out-of-range start clamps without throwing', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': lines(10) } });
    const result = await tool.execute(
      { command: 'view', path: 'x.txt', view_range: [50, 50] },
      makeCtx(),
    );
    assert.match(text(result), /\(lines 10-10 of 10\)/);
  });

  test('caps an unbounded read of a large file', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': lines(700) } });
    const result = await tool.execute({ command: 'view', path: 'x.txt' }, makeCtx());
    assert.match(text(result), /\(lines 1-600 of 700\)/);
    assert.ok(!text(result).includes('line 700'));
  });

  test('returns the whole file when small and no range given', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': lines(5) } });
    const result = await tool.execute({ command: 'view', path: 'x.txt' }, makeCtx());
    assert.ok(text(result).includes('read successfully'));
    assert.ok(text(result).includes('line 1\nline 2\nline 3\nline 4\nline 5'));
  });

  test('handles an empty file without throwing', async () => {
    const tool = viewTool({ fileContents: { 'x.txt': '' } });
    const noRange = await tool.execute({ command: 'view', path: 'x.txt' }, makeCtx());
    assert.ok(text(noRange).includes('read successfully'));
    const ranged = await tool.execute(
      { command: 'view', path: 'x.txt', view_range: [1, 5] },
      makeCtx(),
    );
    assert.match(text(ranged), /\(lines 1-1 of 1\)/);
  });

  test('reads a branch-prefixed storage path', async () => {
    const tool = viewTool({ fileContents: { 'tool-results/s/x.txt': lines(3) } });
    const result = await tool.execute({ command: 'view', path: 'tool-results/s/x.txt' }, makeCtx());
    assert.ok(text(result).includes('line 1\nline 2\nline 3'));
  });
});

describe('FilesystemTool view — file dispatch', () => {
  test('image storage file → multi-content image normalised to JPEG', async () => {
    const tool = viewTool({ fileContents: { 'pic.png': webpFixture } });
    const result = await tool.execute({ command: 'view', path: 'pic.png' }, makeCtx());
    const out = asMulti(result.output);
    assert.equal(out.parts.length, 1);
    assert.equal(out.parts[0]!.kind, 'image');
    assert.equal((out.parts[0] as { image: { mediaType: string } }).image.mediaType, 'image/jpeg');
  });

  test('PDF storage file → extracted text with === filename === header', async () => {
    const tool = viewTool({ fileContents: { 'doc.pdf': makeMinimalPdf('AgentPlace fixture') } });
    const result = await tool.execute({ command: 'view', path: 'doc.pdf' }, makeCtx());
    assert.match(text(result), /=== doc\.pdf ===/);
    assert.match(text(result), /AgentPlace fixture/);
  });

  test('view_range on a non-text file appends an ignored note', async () => {
    const tool = viewTool({ fileContents: { 'doc.pdf': makeMinimalPdf('hi') } });
    const result = await tool.execute(
      { command: 'view', path: 'doc.pdf', view_range: [1, 2] },
      makeCtx(),
    );
    assert.match(text(result), /view_range ignored/);
  });

  test('PPTX → hint directing to the code-executor', async () => {
    const tool = viewTool({ fileContents: { 'deck.pptx': 'x' } });
    const result = await tool.execute({ command: 'view', path: 'deck.pptx' }, makeCtx());
    assert.match(text(result), /code-executor/);
    assert.match(text(result), /soffice/);
  });

  test('HEIC → hint directing to PNG/JPEG', async () => {
    const tool = viewTool({ fileContents: { 'photo.heic': 'x' } });
    const result = await tool.execute({ command: 'view', path: 'photo.heic' }, makeCtx());
    assert.match(text(result), /HEIC\/HEIF not supported/);
  });

  test('constructed sessionKey is used as fallback when agent state has no context', async () => {
    const calls: Array<string | undefined> = [];
    const storage = makeStorage({ fileContents: { 'notes.md': '# hello' } });
    const tool = new FilesystemTool({
      storageFactory: factoryFor(storage, calls),
      sessionKey: 'sess-1',
    });
    const ctx: ToolExecuteContext = {
      runner: { state: { getApp: () => ({}) } } as ToolExecuteContext['runner'],
      toolCallId: 'test-1',
    } as ToolExecuteContext;
    const result = await tool.execute({ command: 'view', path: 'notes.md' }, ctx);
    assert.ok(text(result).includes('# hello'));
    assert.ok(calls.includes('sess-1'), 'falls back to the constructor sessionKey');
  });

  test('state-derived session key takes precedence over the constructed fallback', async () => {
    const calls: Array<string | undefined> = [];
    const storage = makeStorage({ fileContents: { 'notes.md': '# hello' } });
    const tool = new FilesystemTool({
      storageFactory: factoryFor(storage, calls),
      sessionKey: 'fallback-sess',
    });
    const result = await tool.execute(
      { command: 'view', path: 'notes.md' },
      makeCtx({ sessionKey: 'state-sess' }),
    );
    assert.ok(text(result).includes('# hello'));
    assert.ok(calls.includes('state-sess'), 'uses the state-derived key');
    assert.ok(!calls.includes('fallback-sess'), 'state-derived key takes precedence');
  });

  test('agent-storage: reference reads from the session storage', async () => {
    const calls: Array<string | undefined> = [];
    const storage = makeStorage({ fileContents: { 'notes.md': '# hello' } });
    const tool = new FilesystemTool({ storageFactory: factoryFor(storage, calls) });
    const result = await tool.execute(
      { command: 'view', path: 'agent-storage:notes.md' },
      makeCtx({ sessionKey: 'sess-42' }),
    );
    assert.ok(text(result).includes('# hello'));
    assert.ok(calls.includes('sess-42'), 'loader resolves under the session secret folder');
  });

  test('agent-storage: PDF reference → extracted text', async () => {
    const tool = viewTool({ fileContents: { 's.pdf': makeMinimalPdf('from storage') } });
    const result = await tool.execute({ command: 'view', path: 'agent-storage:s.pdf' }, makeCtx());
    assert.match(text(result), /=== s\.pdf ===/);
    assert.match(text(result), /from storage/);
  });

  test('agent-storage: missing file surfaces a read error', async () => {
    const tool = viewTool({ fileContents: {} });
    const result = await tool.execute(
      { command: 'view', path: 'agent-storage:missing.md' },
      makeCtx(),
    );
    assert.match(text(result), /Could not read/);
  });

  test('bare unrouted nonexistent path → clean not-found, no internal adapter error', async () => {
    const result = await viewTool().execute({ command: 'view', path: 'ghost.md' }, makeCtx());
    assert.match(text(result), /No file or directory found at: ghost\.md/);
    assert.ok(!text(result).toLowerCase().includes('adapter'));
  });

  test('aborted signal short-circuits to Canceled.', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await viewTool({ fileContents: { 'x.txt': 'hi' } }).execute(
      { command: 'view', path: 'x.txt' },
      makeCtx({ abortSignal: ac.signal }),
    );
    assert.equal(result.output, 'Canceled.');
  });
});

describe('FilesystemTool view — https URLs', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installFetch(handler: (url: string) => Response): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }) as typeof fetch;
  }

  function bodyResponse(bytes: Uint8Array, contentType: string): Response {
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
    });
  }

  test('https image → multi-content JPEG', async () => {
    installFetch(() => bodyResponse(new Uint8Array(webpFixture), 'image/png'));
    const result = await viewTool().execute(
      { command: 'view', path: 'https://example.io/p.png' },
      makeCtx(),
    );
    const out = asMulti(result.output);
    assert.equal(out.parts[0]!.kind, 'image');
    assert.equal((out.parts[0] as { image: { mediaType: string } }).image.mediaType, 'image/jpeg');
  });

  test('https PDF → extracted text', async () => {
    installFetch(() => bodyResponse(new Uint8Array(makeMinimalPdf('web pdf')), 'application/pdf'));
    const result = await viewTool().execute(
      { command: 'view', path: 'https://example.io/doc.pdf' },
      makeCtx(),
    );
    assert.match(text(result), /web pdf/);
  });

  test('https HTML page → page-fetcher hint', async () => {
    installFetch(() => bodyResponse(new Uint8Array([60, 33]), 'text/html'));
    const result = await viewTool().execute(
      { command: 'view', path: 'https://example.io/blog' },
      makeCtx(),
    );
    assert.match(text(result), /page-fetcher/);
  });
});

describe('FilesystemTool view — directory tree', () => {
  test('no path (depth 1) lists the storage branches', async () => {
    const out = text(await viewTool().execute({ command: 'view' }, makeCtx()));
    assert.match(out, /Storage root/);
    for (const branch of ['private/', 'common/', 'source/', 'tool-results/', 'logs/']) {
      assert.ok(out.includes(branch), `root listing missing ${branch}: ${out}`);
    }
  });

  test('empty branches still appear (no path, depth 2)', async () => {
    const tool = viewTool({ adapterFiles: { private: ['notes.md'] } });
    const out = text(await tool.execute({ command: 'view', depth: 2 }, makeCtx()));
    assert.ok(out.includes('notes.md'));
    for (const branch of ['private/', 'common/', 'logs/']) {
      assert.ok(out.includes(branch), `branch missing at depth 2: ${branch}`);
    }
  });

  test('depth controls how deep the tree goes', async () => {
    const tool = viewTool({ adapterFiles: { private: ['sub/a.txt'] } });
    const shallow = text(await tool.execute({ command: 'view', depth: 2 }, makeCtx()));
    assert.ok(shallow.includes('sub/'));
    assert.ok(!shallow.includes('a.txt'), 'depth 2 should cut sub/ contents');
    const deep = text(await tool.execute({ command: 'view', depth: 3 }, makeCtx()));
    assert.ok(deep.includes('a.txt'), 'depth 3 should reveal sub/a.txt');
  });

  test('bare branch name and trailing slash both descend into the branch', async () => {
    const tool = viewTool({ adapterFiles: { private: ['notes.md', 'sub/a.txt'] } });
    for (const p of ['private', 'private/']) {
      const out = text(await tool.execute({ command: 'view', path: p }, makeCtx()));
      assert.ok(out.includes('notes.md'), `missing notes.md for "${p}": ${out}`);
      assert.ok(out.includes('sub/'), `missing sub/ for "${p}"`);
    }
  });

  test('sub-path descends into a directory inside a branch', async () => {
    const tool = viewTool({ adapterFiles: { source: ['skills/x/SKILL.md', 'mcp.json'] } });
    const out = text(await tool.execute({ command: 'view', path: 'source/skills' }, makeCtx()));
    assert.ok(out.includes('x/'));
    assert.ok(!out.includes('mcp.json'), 'sub-path view should not show siblings outside it');
  });

  test('leading slash is tolerated on a branch path', async () => {
    const tool = viewTool({ adapterFiles: { private: ['notes.md'] } });
    const out = text(await tool.execute({ command: 'view', path: '/private/' }, makeCtx()));
    assert.ok(out.includes('notes.md'));
  });

  test('depth < 1 is rejected', async () => {
    const out = text(await viewTool().execute({ command: 'view', depth: 0 }, makeCtx()));
    assert.match(out, /depth must be a positive integer/);
  });

  test('unknown branch returns a clean not-found result, does not throw', async () => {
    const out = text(await viewTool().execute({ command: 'view', path: 'nope/' }, makeCtx()));
    assert.match(out, /No file or directory found at: nope\//);
    assert.ok(!out.toLowerCase().includes('adapter'), 'must not leak the internal adapter error');
  });

  test('view_range on a directory appends an ignored note', async () => {
    const out = text(await viewTool().execute({ command: 'view', view_range: [1, 2] }, makeCtx()));
    assert.match(out, /view_range ignored/);
  });
});

describe('FilesystemTool write', () => {
  test('writes utf8 content and reports the byte count', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({ storageFactory: factoryFor(makeStorage({ writes })) });
    const result = await tool.execute(
      { command: 'write', path: 'private/out.txt', content: 'hi' },
      makeCtx(),
    );
    assert.ok(text(result).includes('written successfully'));
    assert.deepEqual(writes, [{ path: 'private/out.txt', size: 2, content: 'hi' }]);
  });

  test('write requires a path', async () => {
    const out = text(await viewTool().execute({ command: 'write', content: 'x' }, makeCtx()));
    assert.match(out, /path is required/);
  });

  test('write requires content', async () => {
    const out = text(await viewTool().execute({ command: 'write', path: 'a.txt' }, makeCtx()));
    assert.match(out, /content is required/);
  });
});

describe('FilesystemTool edit', () => {
  function srBlock(search: string, replace: string): string {
    return `------- SEARCH\n${search}\n=======\n${replace}\n+++++++ REPLACE`;
  }

  test('applies a single SEARCH/REPLACE block and writes the result', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'private/doc.md': 'hello world' }, writes }),
      ),
    });
    const result = await tool.execute(
      { command: 'edit', path: 'private/doc.md', content: srBlock('world', 'there') },
      makeCtx(),
    );
    assert.match(text(result), /1 change\(s\) applied/);
    assert.deepEqual(writes, [{ path: 'private/doc.md', size: 11, content: 'hello there' }]);
  });

  test('a no-op edit (search equals replace) writes nothing', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'private/doc.md': 'hello world' }, writes }),
      ),
    });
    const result = await tool.execute(
      { command: 'edit', path: 'private/doc.md', content: srBlock('world', 'world') },
      makeCtx(),
    );
    assert.match(text(result), /No changes needed/);
    assert.equal(writes.length, 0);
  });

  test('applies multiple blocks together', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'common/a.md': 'one two' }, writes }),
      ),
    });
    const content = `${srBlock('one', '1')}\n${srBlock('two', '2')}`;
    const result = await tool.execute({ command: 'edit', path: 'common/a.md', content }, makeCtx());
    assert.match(text(result), /2 change\(s\) applied/);
    assert.equal(writes[0]?.content, '1 2');
  });

  test('all-or-nothing: a non-matching block writes nothing', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'private/doc.md': 'hello world' }, writes }),
      ),
    });
    const content = `${srBlock('hello', 'hi')}\n${srBlock('NOT PRESENT', 'x')}`;
    const result = await tool.execute(
      { command: 'edit', path: 'private/doc.md', content },
      makeCtx(),
    );
    assert.match(text(result), /No changes written/);
    assert.equal(writes.length, 0);
  });

  test('ambiguous match (non-unique SEARCH) writes nothing', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'private/doc.md': 'x\nx' }, writes }),
      ),
    });
    const result = await tool.execute(
      { command: 'edit', path: 'private/doc.md', content: srBlock('x', 'y') },
      makeCtx(),
    );
    assert.match(text(result), /No changes written/);
    assert.equal(writes.length, 0);
  });

  test('content without SEARCH/REPLACE markers writes nothing', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(
        makeStorage({ fileContents: { 'private/doc.md': 'abc' }, writes }),
      ),
    });
    const result = await tool.execute(
      { command: 'edit', path: 'private/doc.md', content: 'just some text' },
      makeCtx(),
    );
    assert.match(text(result), /No changes written/);
    assert.equal(writes.length, 0);
  });

  test('editing a missing file reports a clean error, no write', async () => {
    const writes: Array<{ path: string; size: number; content: string }> = [];
    const tool = new FilesystemTool({
      storageFactory: factoryFor(makeStorage({ writes })),
    });
    const result = await tool.execute(
      { command: 'edit', path: 'private/nope.md', content: srBlock('a', 'b') },
      makeCtx(),
    );
    assert.match(text(result), /no such file/);
    assert.equal(writes.length, 0);
  });

  test('edit requires content', async () => {
    const out = text(
      await viewTool().execute({ command: 'edit', path: 'private/a.md' }, makeCtx()),
    );
    assert.match(out, /content is required/);
  });
});
