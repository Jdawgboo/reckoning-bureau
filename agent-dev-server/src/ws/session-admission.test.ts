import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ANONYMOUS_USER_ID,
  SessionAccessDeniedError,
  SessionCapacityError,
  UNATTENDED_PRINCIPALS,
  assertMayJoinSession,
  describeAdmissionFailure,
  selectEvictableSession,
  type SessionEvictionCandidate,
} from './session-admission.ts';

function candidate(over: Partial<SessionEvictionCandidate> = {}): SessionEvictionCandidate {
  return {
    sessionKey: 'sess-1',
    clientCount: 0,
    status: 'idle',
    remainingTtlMs: 1000,
    ...over,
  };
}

describe('assertMayJoinSession (identity binding)', () => {
  it('admits the identity the session was created for', () => {
    assert.doesNotThrow(() =>
      assertMayJoinSession({
        sessionKey: 'sess-1',
        sessionUserId: 'alice@example.com',
        connectingUserId: 'alice@example.com',
      }),
    );
  });

  // A shared `?agent_session_id=` addresses a conversation; it does not entitle
  // the holder to read it.
  it('refuses a different signed-in user holding the session key', () => {
    assert.throws(
      () =>
        assertMayJoinSession({
          sessionKey: 'sess-1',
          sessionUserId: 'alice@example.com',
          connectingUserId: 'mallory@example.com',
        }),
      SessionAccessDeniedError,
    );
  });

  it('refuses an anonymous caller naming a signed-in user’s session', () => {
    assert.throws(
      () =>
        assertMayJoinSession({
          sessionKey: 'sess-1',
          sessionUserId: 'alice@example.com',
          connectingUserId: ANONYMOUS_USER_ID,
        }),
      SessionAccessDeniedError,
    );
  });

  it('refuses a signed-in caller naming an anonymous session', () => {
    assert.throws(
      () =>
        assertMayJoinSession({
          sessionKey: 'sess-1',
          sessionUserId: ANONYMOUS_USER_ID,
          connectingUserId: 'alice@example.com',
        }),
      SessionAccessDeniedError,
    );
  });

  // Without this exemption every fired schedule's broadcast is refused, and
  // `container.ts` logs nothing on that path — triggers would just go quiet.
  it('admits a scheduled run broadcasting into a signed-in user’s session', () => {
    for (const principal of UNATTENDED_PRINCIPALS) {
      assert.doesNotThrow(
        () =>
          assertMayJoinSession({
            sessionKey: 'sess-1',
            sessionUserId: 'alice@example.com',
            connectingUserId: principal,
          }),
        `${principal} must be able to broadcast into a user session`,
      );
    }
  });

  it('admits the owner opening a session a schedule created', () => {
    for (const principal of UNATTENDED_PRINCIPALS) {
      assert.doesNotThrow(
        () =>
          assertMayJoinSession({
            sessionKey: 'sess-1',
            sessionUserId: principal,
            connectingUserId: 'alice@example.com',
          }),
        `a user must be able to read a ${principal} session`,
      );
    }
  });

  // The exemption is for identities the runtime stamps on itself. The MCP and
  // HTTP routes label EXTERNAL callers, so exempting those would defeat the rule.
  it('does not exempt the external-caller sentinels', () => {
    for (const sentinel of ['mcp-user', 'api-user', 'import-user']) {
      assert.throws(
        () =>
          assertMayJoinSession({
            sessionKey: 'sess-1',
            sessionUserId: 'alice@example.com',
            connectingUserId: sentinel,
          }),
        SessionAccessDeniedError,
        `${sentinel} must not be able to attach to a user session`,
      );
    }
  });

  // Each entry point spells "no identity" differently. An unauthenticated caller
  // that posts over HTTP and resumes over the socket must keep working — the
  // sentinels differ, the principal does not.
  it('treats every no-identity sentinel as one principal', () => {
    for (const sentinel of ['api-user', 'import-user']) {
      assert.doesNotThrow(() =>
        assertMayJoinSession({
          sessionKey: 'sess-1',
          sessionUserId: sentinel,
          connectingUserId: ANONYMOUS_USER_ID,
        }),
      );
    }
  });

  // ...but an authenticated MCP client is NOT one of them.
  it('refuses an MCP caller attaching to an anonymous visitor’s session', () => {
    assert.throws(
      () =>
        assertMayJoinSession({
          sessionKey: 'sess-1',
          sessionUserId: ANONYMOUS_USER_ID,
          connectingUserId: 'mcp-user',
        }),
      SessionAccessDeniedError,
    );
  });

  // Documents the limit stated in the module header rather than asserting a
  // desirable outcome: on an agent that does not require sign-in every visitor is
  // `'anonymous'`, so identity binding cannot tell two of them apart. If this
  // ever starts throwing, sessions gained a per-visitor identity and the
  // header's caveat is stale.
  it('cannot separate two anonymous visitors — the documented limit', () => {
    assert.doesNotThrow(() =>
      assertMayJoinSession({
        sessionKey: 'sess-1',
        sessionUserId: ANONYMOUS_USER_ID,
        connectingUserId: ANONYMOUS_USER_ID,
      }),
    );
  });
});

describe('selectEvictableSession (allocation cap)', () => {
  it('returns null when there is nothing to evict', () => {
    assert.strictEqual(selectEvictableSession([]), null);
  });

  it('never evicts a session with a connected client', () => {
    assert.strictEqual(
      selectEvictableSession([candidate({ sessionKey: 'busy', clientCount: 1 })]),
      null,
    );
  });

  it('never evicts a session with a run in flight', () => {
    assert.strictEqual(
      selectEvictableSession([candidate({ sessionKey: 'running', status: 'processing' })]),
      null,
    );
  });

  it('evicts the idle session closest to expiry', () => {
    const evictable = selectEvictableSession([
      candidate({ sessionKey: 'fresh', remainingTtlMs: 9000 }),
      candidate({ sessionKey: 'stalest', remainingTtlMs: 10 }),
      candidate({ sessionKey: 'middle', remainingTtlMs: 500 }),
    ]);
    assert.strictEqual(evictable, 'stalest');
  });

  // Bulk-allocated ids become exactly the idle sessions this prefers to drop, so
  // a visitor with an open connection must survive a full table.
  it('skips connected sessions even when they are the stalest', () => {
    const evictable = selectEvictableSession([
      candidate({ sessionKey: 'connected', clientCount: 2, remainingTtlMs: 1 }),
      candidate({ sessionKey: 'idle', remainingTtlMs: 8000 }),
    ]);
    assert.strictEqual(evictable, 'idle');
  });
});

describe('describeAdmissionFailure', () => {
  it('maps a denied session to a policy-violation close', () => {
    const frame = describeAdmissionFailure(new SessionAccessDeniedError('nope'));
    assert.strictEqual(frame?.code, 1008);
  });

  it('maps a capacity refusal to try-again-later', () => {
    const frame = describeAdmissionFailure(new SessionCapacityError('full'));
    assert.strictEqual(frame?.code, 1013);
  });

  it('leaves an unrelated error to the caller’s internal-error path', () => {
    assert.strictEqual(describeAdmissionFailure(new Error('boom')), null);
  });

  // `base-error.ts` re-parents every instance to `BaseError.prototype`, so a
  // subclass that forgets to re-set its own prototype fails `instanceof` and
  // silently falls through to 1011. Guard the mapping against that.
  it('distinguishes the two admission errors by instanceof', () => {
    assert.ok(new SessionAccessDeniedError('x') instanceof SessionAccessDeniedError);
    assert.ok(new SessionCapacityError('x') instanceof SessionCapacityError);
    assert.ok(!(new SessionCapacityError('x') instanceof SessionAccessDeniedError));
  });
});
