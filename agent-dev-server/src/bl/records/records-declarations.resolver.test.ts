import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CollectionDeclaration } from '../../../vendor/agent-library/records/types.ts';
import {
  resolveRecordsDeclarations,
  type DeclarationsReader,
} from './records-declarations.resolver.ts';

const bookings: CollectionDeclaration = {
  name: 'bookings',
  ops: ['create', 'get', 'query', 'update'],
  scope: 'session',
};

class ScriptedReader implements DeclarationsReader {
  calls = 0;
  #result: CollectionDeclaration[] | Error;

  constructor(result: CollectionDeclaration[] | Error) {
    this.#result = result;
  }

  async listDeclarations(): Promise<CollectionDeclaration[]> {
    this.calls += 1;
    if (this.#result instanceof Error) {
      throw this.#result;
    }
    return this.#result;
  }
}

// The memo is module state, so these cases are ordered: a successful read has to
// happen before the fallback can be observed.
describe('resolveRecordsDeclarations', () => {
  it('returns what the platform reported', async () => {
    assert.deepStrictEqual(await resolveRecordsDeclarations(new ScriptedReader([bookings])), [
      bookings,
    ]);
  });

  it('reuses the last known set when the read fails, instead of dropping the contract', async () => {
    const failing = new ScriptedReader(new Error('Transport offline and request is volatile'));
    assert.deepStrictEqual(await resolveRecordsDeclarations(failing), [bookings]);
    assert.strictEqual(failing.calls, 1);
  });

  it('lets a successful read clear collections that are gone', async () => {
    assert.deepStrictEqual(await resolveRecordsDeclarations(new ScriptedReader([])), []);
  });
});
