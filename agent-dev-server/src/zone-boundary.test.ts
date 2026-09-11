/**
 * Zone boundary: platform code must not depend on the builder-editable agent
 * anchors (`src/surfaces/`, `src/config.ts`) except through the sanctioned
 * seams below. A new platform→agent import means a builder edit can break
 * the platform — fail here instead of in production.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
/** The agent anchors themselves — everything else under src/ is platform code. */
const EXCLUDED_ROOT_ENTRIES = new Set(['surfaces', 'config.ts']);

/** file (relative to src) → agent-anchor specifiers it may import */
const SANCTIONED_SEAMS: Record<string, string[]> = {
  'bl/messaging/tool-registry.factory.ts': ['../../surfaces/index.ts'],
  'bl/config-bridge.ts': ['../config.ts'],
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
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
}

/** True when a relative specifier lands in `src/surfaces/` or on
 *  `src/config.ts` — both `../` climbs and same-dir `./` forms. Segment-anchored
 *  so `./bl/tools/mcp-config.ts` or `./context-management.config.ts` never match. */
function isAgentAnchorImport(specifier: string): boolean {
  if (!specifier.startsWith('.')) {
    return false;
  }
  return (
    /(?:^|\/)\.{1,2}\/surfaces\//.test(specifier) ||
    /(?:^|\/)\.{1,2}\/config(\.ts)?$/.test(specifier)
  );
}

function collectPlatformFiles(): string[] {
  const files: string[] = [];
  for (const name of readdirSync(SRC_DIR)) {
    if (EXCLUDED_ROOT_ENTRIES.has(name)) {
      continue;
    }
    const path = join(SRC_DIR, name);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else if (name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files.filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'));
}

describe('server zone boundary', () => {
  it('platform code imports the agent anchors only via the sanctioned seams', () => {
    const files = collectPlatformFiles();

    const violations: string[] = [];
    for (const path of files) {
      const rel = relative(SRC_DIR, path);
      const allowed = SANCTIONED_SEAMS[rel] ?? [];
      const code = stripComments(readFileSync(path, 'utf8'));
      const specifiers = [...code.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        if (isAgentAnchorImport(specifier) && !allowed.includes(specifier)) {
          violations.push(`${rel} ← '${specifier}'`);
        }
      }
    }
    assert.deepStrictEqual(violations, [], 'unsanctioned platform→agent import edges');
  });

  it('the sanctioned seams still exist (the allowlist is not stale)', () => {
    for (const [rel, specifiers] of Object.entries(SANCTIONED_SEAMS)) {
      const source = readFileSync(join(SRC_DIR, rel), 'utf8');
      for (const specifier of specifiers) {
        assert.ok(source.includes(`'${specifier}'`), `${rel} no longer imports '${specifier}'`);
      }
    }
  });
});
