import assert from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const APP_LIB = path.resolve(import.meta.dirname, '..');
const EXCLUDED_SEGMENTS = ['/gallery/', '/localization/messages.ts'];
const STABLE_ATTRIBUTE = /\b(?:aria-label|placeholder|title|alt)\s*=\s*["']([A-Za-z][^"']*)["']/g;
const STABLE_TEXT_NODE = />\s*([A-Za-z][A-Za-z0-9 ,.!?():’'-]{2,})\s*<\//g;

describe('stable visitor copy audit', () => {
  it('keeps literal product wording in the extracted localization catalog', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(APP_LIB)) {
      const relative = `/${path.relative(APP_LIB, file)}`;
      if (
        file.endsWith('.test.ts') ||
        file.endsWith('.test.tsx') ||
        EXCLUDED_SEGMENTS.some((segment) => relative.includes(segment))
      ) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      collectMatches(violations, relative, source, STABLE_ATTRIBUTE);
      collectMatches(violations, relative, source, STABLE_TEXT_NODE);
    }

    assert.deepStrictEqual(violations, []);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(resolved);
      }
      return /\.tsx?$/.test(entry.name) ? [resolved] : [];
    }),
  );
  return nested.flat();
}

function collectMatches(
  violations: string[],
  relative: string,
  source: string,
  pattern: RegExp,
): void {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${relative}:${line}: ${match[1]}`);
  }
}
