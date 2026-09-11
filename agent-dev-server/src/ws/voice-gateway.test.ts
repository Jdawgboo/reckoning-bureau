import assert from 'node:assert';
import { describe, it } from 'node:test';
import { activationSpeakFirst } from './voice-gateway.ts';

describe('activationSpeakFirst', () => {
  it('lets the browser claim the greeting for a conversation with history', () => {
    assert.strictEqual(activationSpeakFirst({ type: 'voice.activate', greet: true }, false), true);
  });

  it('lets the browser suppress a re-greet on a fresh conversation', () => {
    assert.strictEqual(activationSpeakFirst({ type: 'voice.activate', greet: false }, true), false);
  });

  it('keeps the connection default for a browser without the field', () => {
    assert.strictEqual(activationSpeakFirst({ type: 'voice.activate' }, true), true);
    assert.strictEqual(
      activationSpeakFirst({ type: 'voice.activate', greet: 'yes' }, false),
      false,
    );
  });
});
