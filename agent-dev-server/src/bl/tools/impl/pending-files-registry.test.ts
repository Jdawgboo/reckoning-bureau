import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PendingFilesRegistry } from './pending-files-registry.ts';

describe('PendingFilesRegistry', () => {
  test('markPending adds the id and listPending returns it', () => {
    const r = new PendingFilesRegistry();
    r.markPending('file_A');
    assert.equal(r.has('file_A'), true);
    assert.deepStrictEqual(r.listPending(), ['file_A']);
  });

  test('listPending excludes processed entries', () => {
    const r = new PendingFilesRegistry();
    r.markPending('file_A');
    r.markPending('file_B');
    r.markProcessed('file_A');
    assert.deepStrictEqual(r.listPending(), ['file_B']);
    assert.equal(r.has('file_A'), true, 'has() still returns true for processed entries');
  });

  test('markPending on an already-processed id is a no-op (does not downgrade)', () => {
    const r = new PendingFilesRegistry();
    r.markPending('file_A');
    r.markProcessed('file_A');
    // Re-registration should not move it back into pending.
    r.markPending('file_A');
    assert.deepStrictEqual(r.listPending(), []);
  });

  test('repeated markPending on a fresh id is idempotent', () => {
    const r = new PendingFilesRegistry();
    r.markPending('file_A');
    r.markPending('file_A');
    r.markPending('file_A');
    assert.deepStrictEqual(r.listPending(), ['file_A']);
  });
});
