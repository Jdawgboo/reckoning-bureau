import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const A2UI_DIR = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(join(A2UI_DIR, relativePath), 'utf8');
}

describe('surface layout contract', () => {
  it('leaves SurfaceHeader width to its caller', () => {
    const header = source('blocks/SurfaceHeader.tsx');

    assert.doesNotMatch(header, /mx-auto/, 'header elements must share the caller left rail');
    assert.doesNotMatch(
      header,
      /max-w-container-/,
      'header children must not establish a narrower nested container',
    );
  });

  it('leaves TextBlock width to the stage content container', () => {
    const textBlock = source('builtin-catalog/TextBlock.tsx');

    assert.doesNotMatch(textBlock, /mx-auto/, 'TextBlock children must share one left rail');
    assert.doesNotMatch(
      textBlock,
      /max-w-container-/,
      'TextBlock must not narrow the stage content container',
    );
  });

  it('uses the fixed form tier for Form geometry', () => {
    const form = source('builtin-catalog/Form.tsx');

    assert.match(form, /max-w-container-form/);
    assert.doesNotMatch(form, /mx-auto/);
  });

  it('keeps MarkdownText typography independent from container geometry', () => {
    const markdown = source('blocks/MarkdownText.tsx');

    assert.doesNotMatch(markdown, /max-w-container-/);
    assert.doesNotMatch(markdown, /mx-auto/);
  });
});
