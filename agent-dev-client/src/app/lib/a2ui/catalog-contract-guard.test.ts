/**
 * Contract↔component name-match guard: every surface contract the SERVER
 * registers (agent + builtin catalogs) must have a client React component
 * registered under the SAME name, and vice versa. The pairing is a raw string
 * across two packages — a half-registered screen otherwise fails at runtime
 * as a skeleton instead of failing this build. fs-based scan, same approach
 * as the zone-boundary tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = join(__dirname, '..', '..', '..', '..');
const SERVER_ROOT = join(CLIENT_ROOT, '..', 'agent-dev-server', 'src');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** `component: 'Name'` occurrences in a server contract source file. */
function contractNames(filePath: string): string[] {
  const source = stripComments(readFileSync(filePath, 'utf-8'));
  return [...source.matchAll(/component:\s*'([A-Za-z0-9]+)'/g)].map((match) => match[1]);
}

/** Registry keys of a `Record<string, FC<...>>` object literal export. */
function registryKeys(filePath: string, exportName: string): string[] {
  const source = stripComments(readFileSync(filePath, 'utf-8'));
  const start = source.indexOf(exportName);
  assert.notEqual(start, -1, `${exportName} not found in ${filePath}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/(?:^|[,{]\s*|\n\s*)([A-Za-z0-9]+)\s*[,:}]/g)]
    .map((match) => match[1])
    .filter((key) => /^[A-Z]/.test(key));
}

describe('surface catalog contract↔component pairing', () => {
  it('builtin contracts and client builtin components match by name', () => {
    const contractDir = join(SERVER_ROOT, 'bl', 'builtin-catalog');
    const serverNames = new Set(
      readdirSync(contractDir)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .flatMap((file) => contractNames(join(contractDir, file))),
    );
    const clientKeys = new Set(
      registryKeys(
        join(CLIENT_ROOT, 'src', 'app', 'lib', 'a2ui', 'builtin-catalog', 'index.ts'),
        'BUILTIN_SURFACE_COMPONENTS',
      ),
    );
    assert.deepStrictEqual(
      [...serverNames].sort(),
      [...clientKeys].sort(),
      'builtin contract names and client component registry keys must match 1:1',
    );
  });

  it('agent contracts all have client components (agent zone)', () => {
    const serverNames = contractNames(join(SERVER_ROOT, 'surfaces', 'index.ts'));
    const clientKeys = new Set(
      registryKeys(
        join(CLIENT_ROOT, 'src', 'app', 'agent', 'surfaces', 'index.ts'),
        'AGENT_SURFACE_COMPONENTS',
      ),
    );
    for (const name of serverNames) {
      assert.ok(
        clientKeys.has(name),
        `agent contract '${name}' has no client component registered under that name`,
      );
    }
  });
});
