import { describe, it } from 'node:test';
import assert from 'node:assert';
import { terminalCloseReason } from './ws-close-policy.ts';

describe('terminalCloseReason', () => {
  it('ends the connection when the runtime refuses the session', () => {
    const reason = terminalCloseReason(1008);
    assert.ok(reason, '1008 must stop the reconnect loop');
    assert.match(reason, /different account/);
  });

  it('ends the connection on an authentication failure', () => {
    assert.strictEqual(terminalCloseReason(4001), 'Authentication error');
  });

  // The whole point of the split: at-capacity IS worth retrying, so it must fall
  // through to the adapter's normal backoff rather than being treated as fatal.
  it('keeps retrying when the runtime is at capacity', () => {
    assert.strictEqual(terminalCloseReason(1013), null);
  });

  it('keeps retrying on a normal or abnormal disconnect', () => {
    for (const code of [1000, 1001, 1005, 1006, 1011, 1012]) {
      assert.strictEqual(terminalCloseReason(code), null, `${code} must stay retryable`);
    }
  });

  // `CloseEvent` is absent when the adapter reports a failure with no close frame;
  // that is a transport problem, not a refusal, so it must remain retryable.
  it('keeps retrying when no close code is available', () => {
    assert.strictEqual(terminalCloseReason(undefined), null);
  });
});
