import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentSession } from './agent-session.ts';

function makeSession(): AgentSession {
  return new AgentSession({
    sessionKey: 'voice-admission',
    userId: 'user-1',
    configId: 'agent-1',
    ttlMs: 60_000,
  });
}

describe('AgentSession voice turn admission', () => {
  it('is prospective and has no replay for turns accepted before attachment', () => {
    const session = makeSession();
    session.notifyTurnAccepted('before-attachment');

    const received: string[] = [];
    const unsubscribe = session.subscribeAcceptedTurns((responseId) => received.push(responseId));
    session.notifyTurnAccepted('after-attachment');
    unsubscribe();
    session.notifyTurnAccepted('after-detach');

    assert.deepStrictEqual(received, ['after-attachment']);
  });

  it('replaces the listener synchronously and ignores a stale release', () => {
    const session = makeSession();
    const revoked: string[] = [];
    const releaseFirst = session.acquireVoiceAttachment(() => revoked.push('first'));
    assert.strictEqual(session.voiceChannelActive, true);

    const releaseSecond = session.acquireVoiceAttachment(() => revoked.push('second'));
    assert.deepStrictEqual(revoked, ['first']);
    releaseFirst();
    assert.strictEqual(
      session.voiceChannelActive,
      true,
      'the replaced owner cannot clear its successor',
    );

    releaseSecond();
    assert.strictEqual(session.voiceChannelActive, false);
  });

  it('revokes the active listener during session cleanup', () => {
    const session = makeSession();
    let revoked = false;
    session.acquireVoiceAttachment(() => {
      revoked = true;
    });

    session.cleanup();

    assert.strictEqual(revoked, true);
    assert.strictEqual(session.voiceChannelActive, false);
  });
});
