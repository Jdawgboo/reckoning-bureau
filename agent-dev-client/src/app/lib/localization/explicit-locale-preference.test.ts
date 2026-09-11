import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  type LocalePreferenceStorage,
  loadExplicitLocalePreference,
  refreshExplicitLocalePreference,
  saveExplicitLocalePreference,
} from './explicit-locale-preference.ts';

class MemoryStorage implements LocalePreferenceStorage {
  readonly values = new Map<string, string>();
  throws = false;

  getItem(key: string): string | null {
    if (this.throws) {
      throw new Error('storage unavailable');
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throws) {
      throw new Error('storage unavailable');
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throws) {
      throw new Error('storage unavailable');
    }
    this.values.delete(key);
  }
}

describe('explicit locale preference', () => {
  it('canonicalizes and restores the visitor choice', () => {
    const storage = new MemoryStorage();

    assert.strictEqual(saveExplicitLocalePreference(' fr-ca ', storage), true);
    assert.strictEqual(loadExplicitLocalePreference(storage), 'fr-CA');
  });

  it('removes malformed values and ignores unavailable storage', () => {
    const storage = new MemoryStorage();
    storage.values.set('agentplace.explicit-locale.v1', 'not_a_locale');

    assert.strictEqual(loadExplicitLocalePreference(storage), null);
    assert.strictEqual(storage.values.size, 0);

    storage.throws = true;
    assert.strictEqual(loadExplicitLocalePreference(storage), null);
    assert.strictEqual(saveExplicitLocalePreference('en', storage), false);
  });

  it('uses the latest stored value but preserves memory when storage is unavailable', () => {
    const storage = new MemoryStorage();
    saveExplicitLocalePreference('pl', storage);

    assert.strictEqual(refreshExplicitLocalePreference('en', storage), 'pl');

    storage.throws = true;
    assert.strictEqual(refreshExplicitLocalePreference('pl', storage), 'pl');
  });
});
