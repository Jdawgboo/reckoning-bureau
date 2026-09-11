import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentSession } from './agent-session.ts';

function createSession(): AgentSession {
  return new AgentSession({
    sessionKey: 'sess-turn-error',
    userId: 'user-1',
    configId: 'config-1',
    ttlMs: 60_000,
  });
}

describe('AgentSession — last turn error', () => {
  it('is null until a turn fails', () => {
    assert.strictEqual(createSession().lastTurnError, null);
  });

  it('records the reason and the run it belongs to', () => {
    const session = createSession();

    session.broadcastContent({
      type: 'error',
      messageId: 'error',
      error: 'Provider temporarily unavailable',
      responseId: 'run-1',
    });

    assert.deepStrictEqual(session.lastTurnError, {
      responseId: 'run-1',
      error: 'Provider temporarily unavailable',
    });
  });

  it('ignores ordinary content, so a healthy turn reports nothing', () => {
    const session = createSession();

    session.broadcastContent({
      type: 'TXT',
      messageId: 'm1',
      content: 'Booked.',
      responseId: 'run-1',
    });
    session.broadcastContent({ type: 'finish', messageId: 'finish', responseId: 'run-1' });

    assert.strictEqual(session.lastTurnError, null);
  });

  it('keeps the newest failure, so a later run is never judged by an older one', () => {
    const session = createSession();

    session.broadcastContent({
      type: 'error',
      messageId: 'error',
      error: 'Rate limited',
      responseId: 'run-1',
    });
    session.broadcastContent({
      type: 'error',
      messageId: 'error',
      error: 'Unexpected error occurred',
      responseId: 'run-2',
    });

    assert.deepStrictEqual(session.lastTurnError, {
      responseId: 'run-2',
      error: 'Unexpected error occurred',
    });
  });

  it('survives the turn going idle, which is when the caller reads it', () => {
    const session = createSession();

    session.setStatus('processing');
    session.broadcastContent({
      type: 'error',
      messageId: 'error',
      error: 'Provider temporarily unavailable',
      responseId: 'run-1',
    });
    session.setStatus('idle');

    assert.deepStrictEqual(session.lastTurnError, {
      responseId: 'run-1',
      error: 'Provider temporarily unavailable',
    });
  });

  it('is cleared when the next turn starts, so a healthy turn is never judged by it', () => {
    const session = createSession();

    session.broadcastContent({
      type: 'error',
      messageId: 'error',
      error: 'Rate limited',
      responseId: 'run-1',
    });
    session.setStatus('processing');

    assert.strictEqual(session.lastTurnError, null);
  });

  it('records a failure that arrives without a run id', () => {
    const session = createSession();

    session.broadcastContent({ type: 'error', messageId: 'error', error: 'Boom' });

    assert.deepStrictEqual(session.lastTurnError, { responseId: null, error: 'Boom' });
  });
});
