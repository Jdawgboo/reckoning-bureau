import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createStaticFileHandler } from './static-files.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test('revalidates stable build filenames and reads replacements from disk', async () => {
  const staticDir = await mkdtemp(join(tmpdir(), 'agent-static-files-'));
  temporaryDirectories.push(staticDir);
  const mainPath = join(staticDir, 'main.js');
  await writeFile(mainPath, 'old');

  const handler = createStaticFileHandler(staticDir);
  const server = createServer((request, response) => handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/main.js`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const etag = response.headers.get('etag');
    assert(etag);
    assert.equal(await response.text(), 'old');

    const unchanged = await fetch(`http://127.0.0.1:${address.port}/main.js`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(unchanged.status, 304);

    await writeFile(mainPath, 'console.log("replacement build")');
    const replacement = await fetch(`http://127.0.0.1:${address.port}/main.js`, {
      headers: { 'If-None-Match': etag },
    });

    assert.equal(replacement.status, 200);
    assert.equal(await replacement.text(), 'console.log("replacement build")');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
