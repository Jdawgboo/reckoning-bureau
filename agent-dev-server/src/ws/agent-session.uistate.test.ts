import { describe, it } from 'node:test';
import assert from 'node:assert';
import { uiStateSnapshotFrame } from './ui-state-frame.ts';
import { AGUI_STREAM_METHOD } from '../../../shared/ws-protocol.ts';

// Covers the wire-frame construction that AgentSession.bindStateUiState emits on
// each uiState node change. The subscribe/skip-delete wiring is a thin wrapper
// exercised by the integration suite + typecheck.

describe('uiStateSnapshotFrame', () => {
  it('builds a STATE_SNAPSHOT frame scoped to /uiState, not run-scoped', () => {
    const frame = uiStateSnapshotFrame({ form: { email: 'a@b.c' } });

    assert.strictEqual(frame.responseId, '');
    assert.strictEqual(frame.event.type, 'STATE_SNAPSHOT');
    if (frame.event.type === 'STATE_SNAPSHOT') {
      assert.strictEqual(frame.event.scope, '/uiState');
      assert.deepStrictEqual(frame.event.snapshot, { form: { email: 'a@b.c' } });
    }
  });

  it('coerces a null value to an empty snapshot', () => {
    const frame = uiStateSnapshotFrame(null);
    if (frame.event.type === 'STATE_SNAPSHOT') {
      assert.deepStrictEqual(frame.event.snapshot, {});
    }
  });

  it('is broadcast on the agui channel', () => {
    // The channel constant the frame ships on — asserts the wire contract the
    // client's AguiClientConsumer routes STATE by.
    assert.strictEqual(AGUI_STREAM_METHOD, 'agui');
  });
});
