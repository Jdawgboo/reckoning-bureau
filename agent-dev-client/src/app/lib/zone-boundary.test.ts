/**
 * Zone boundary: platform code (`lib/**`, `App.tsx`) must not depend on the
 * builder-editable agent zone, except through the sanctioned seams below.
 * A new lib→agent import means a builder edit can break the platform —
 * fail here instead of in production.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(LIB_DIR);

/** file (relative to src/app) → import specifiers it may draw from the agent zone */
const SANCTIONED_SEAMS: Record<string, string[]> = {
  'lib/a2ui/SurfaceRenderer.tsx': ['@/app/agent/surfaces/index.ts'],
  'lib/stage/TranscriptPage.tsx': ['@/app/agent/renderers'],
  'App.tsx': ['./agent/site-config.ts'],
  'container.ts': ['./agent/site-config', './agent/presentation-contract'],
};

function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
}

function agentImportsOf(path: string): string[] {
  const code = stripComments(readFileSync(path, 'utf8'));
  const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  return specifiers.filter(
    (specifier) => specifier.includes('@/app/agent/') || /(^|\/)\.\.?\/.*\bagent\//.test(specifier),
  );
}

describe('client zone boundary', () => {
  it('lib and App import from the agent zone only via the sanctioned seams', () => {
    const files: string[] = [];
    walk(LIB_DIR, files);
    files.push(join(APP_DIR, 'App.tsx'));
    files.push(join(APP_DIR, 'container.ts'));

    const violations: string[] = [];
    for (const path of files) {
      const rel = relative(APP_DIR, path);
      const allowed = SANCTIONED_SEAMS[rel] ?? [];
      for (const specifier of agentImportsOf(path)) {
        if (!allowed.includes(specifier)) {
          violations.push(`${rel} ← '${specifier}'`);
        }
      }
    }
    assert.deepStrictEqual(violations, [], 'unsanctioned platform→agent import edges');
  });

  it('the sanctioned seams still exist (the allowlist is not stale)', () => {
    for (const [rel, specifiers] of Object.entries(SANCTIONED_SEAMS)) {
      const source = readFileSync(join(APP_DIR, rel), 'utf8');
      for (const specifier of specifiers) {
        assert.ok(source.includes(`'${specifier}'`), `${rel} no longer imports '${specifier}'`);
      }
    }
  });
});
