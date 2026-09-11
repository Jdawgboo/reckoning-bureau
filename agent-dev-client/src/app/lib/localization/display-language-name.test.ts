import assert from 'node:assert';
import { describe, it } from 'node:test';
import { displayLanguageName } from './display-language-name.ts';

describe('displayLanguageName', () => {
  it('formats the target language in the surrounding interface language', () => {
    assert.strictEqual(displayLanguageName('ka', 'ru'), 'грузинский');
    assert.strictEqual(displayLanguageName('ka', 'en'), 'Georgian');
  });

  it('falls back to the locale when Intl cannot format it', () => {
    assert.strictEqual(displayLanguageName('not_a_locale', 'en'), 'not_a_locale');
  });

  it('uses the target autonym when the browser lacks display-locale data', () => {
    assert.strictEqual(Intl.DisplayNames.supportedLocalesOf(['zza']).length, 0);
    assert.strictEqual(displayLanguageName('ka', 'zza'), 'ქართული');
    assert.strictEqual(displayLanguageName('cy', 'zza'), 'Cymraeg');
  });

  it('uses the neutral locale code only when the target autonym is unavailable', () => {
    assert.strictEqual(displayLanguageName('zza', 'zza'), 'zza');
  });

  it('uses the active bundle self-name without depending on browser locale data', () => {
    assert.strictEqual(displayLanguageName('ka', 'ka', 'ქართული'), 'ქართული');
  });
});
