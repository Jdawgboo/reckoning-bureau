import assert from 'node:assert';
import { describe, it } from 'node:test';
import { runBusyAfterVoiceState } from './voice-run-indicator.ts';

describe('voice run indicator', () => {
  it('keeps a working run up through every live-session state', () => {
    assert.strictEqual(runBusyAfterVoiceState(true, 'speaking'), true);
    assert.strictEqual(runBusyAfterVoiceState(true, 'listening'), true);
    assert.strictEqual(
      runBusyAfterVoiceState(true, 'thinking'),
      true,
      'the visitor talking mid-run does not finish the run',
    );
    assert.strictEqual(runBusyAfterVoiceState(true, 'building'), true);
  });

  it('never raises the indicator itself — that is the voice.run edge alone', () => {
    assert.strictEqual(
      runBusyAfterVoiceState(false, 'building'),
      false,
      'a tool call that never delegates a run must not leave the indicator up',
    );
  });

  it('clears when the live session ends', () => {
    assert.strictEqual(runBusyAfterVoiceState(true, 'idle'), false);
    assert.strictEqual(runBusyAfterVoiceState(true, 'connecting'), false);
  });
});
