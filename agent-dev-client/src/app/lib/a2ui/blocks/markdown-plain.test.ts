import { describe, it } from 'node:test';
import assert from 'node:assert';
import { plainTextFromMarkdown } from './markdown-plain.ts';

describe('plainTextFromMarkdown', () => {
  it('strips inline markers', () => {
    assert.strictEqual(
      plainTextFromMarkdown('We are **open** from `9:00` on _weekdays_.'),
      'We are open from 9:00 on weekdays.',
    );
  });

  it('keeps link and image labels, drops urls', () => {
    assert.strictEqual(
      plainTextFromMarkdown('See [our map](https://x.test) and ![logo](https://x.test/l.png)'),
      'See our map and logo',
    );
  });

  it('strips heading, quote, and list prefixes per line', () => {
    assert.strictEqual(
      plainTextFromMarkdown('## Opening hours\n- Mon 9:00\n1. First\n> note'),
      'Opening hours\nMon 9:00\nFirst\nnote',
    );
  });

  it('leaves plain text untouched', () => {
    assert.strictEqual(plainTextFromMarkdown('Just a sentence.'), 'Just a sentence.');
  });
});
