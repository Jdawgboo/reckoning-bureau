/**
 * Executable "generic zone" rule: nothing in `blocks/` may mention a domain
 * word in code — a law firm and a repair shop must be able to use every
 * block unchanged. Domain semantics live in `../signature/`. Comments are
 * stripped before matching so blocks may still explain WHY they are generic.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const BLOCKS_DIR = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /booking|service|slot|intake|scooter|salon/i;

/** Strip `//` line comments and `/* … *\/` block comments, line-based. */
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

describe('blocks generic boundary', () => {
  const blockFiles = readdirSync(BLOCKS_DIR).filter((name) => name.endsWith('.tsx'));

  it('has block files to check', () => {
    assert.ok(blockFiles.length >= 8, `expected the 8 blocks, found ${blockFiles.length}`);
  });

  for (const file of blockFiles) {
    it(`${file} contains no domain words outside comments`, () => {
      const source = readFileSync(join(BLOCKS_DIR, file), 'utf8');
      const code = stripComments(source);
      const offending = code
        .split('\n')
        .map((line, index) => ({ line, lineNo: index + 1 }))
        .filter(({ line }) => FORBIDDEN.test(line));
      assert.deepStrictEqual(
        offending,
        [],
        `${file} leaks domain vocabulary into the generic blocks zone`,
      );
    });
  }
});
