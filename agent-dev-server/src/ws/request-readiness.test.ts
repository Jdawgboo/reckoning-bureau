import assert from 'node:assert';
import { describe, it } from 'node:test';

import { bindRequestsToReadyContext } from './request-readiness.ts';

describe('bindRequestsToReadyContext', () => {
  it('registers synchronously and holds an early request until context is ready', async () => {
    let releaseContext: (context: { sessionKey: string }) => void = () => {};
    const contextReady = new Promise<{ sessionKey: string }>((resolve) => {
      releaseContext = resolve;
    });
    let registeredHandler: ((request: { method: string }) => Promise<unknown>) | null = null;
    const handled: string[] = [];
    const boundContext = bindRequestsToReadyContext<
      { sessionKey: string },
      { method: string },
      unknown
    >(
      (handler) => {
        registeredHandler = handler;
      },
      contextReady,
      (context, request: { method: string }) => {
        handled.push(request.method);
        return { sessionKey: context.sessionKey };
      },
    );

    assert.notStrictEqual(registeredHandler, null);
    const response = registeredHandler({ method: 'session.info' });
    await Promise.resolve();
    assert.deepStrictEqual(handled, []);

    releaseContext({ sessionKey: 'session-1' });
    assert.deepStrictEqual(await response, { sessionKey: 'session-1' });
    assert.deepStrictEqual(await boundContext, { sessionKey: 'session-1' });
    assert.deepStrictEqual(handled, ['session.info']);
  });
});
