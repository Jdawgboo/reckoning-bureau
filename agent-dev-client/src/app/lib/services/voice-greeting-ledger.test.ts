import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { claimFirstVoiceOpen, resetVoiceGreetingLedgerForTests } from './voice-greeting-ledger.ts';

describe('voice greeting ledger', () => {
  beforeEach(() => resetVoiceGreetingLedgerForTests());

  it('grants the greeting to the first voice open of a page load only', () => {
    assert.strictEqual(claimFirstVoiceOpen(), true);
    assert.strictEqual(claimFirstVoiceOpen(), false);
    assert.strictEqual(claimFirstVoiceOpen(), false);
  });
});
