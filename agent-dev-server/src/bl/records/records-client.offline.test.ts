/**
 * The declarations read is awaited before the first model call on every run
 * path, so it must never outlive its timeout. `RpcPeer` arms the timeout timer
 * only inside its connected send path: a retryable request issued while the
 * socket is down is buffered with NO timer and settles whenever the socket
 * returns. These cases run the real `RpcPeer` against a disconnected transport
 * to prove the declarations read rejects and an ordinary record call does not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RpcPeer } from '../../../vendor/agentplace-transport/RpcPeer.ts';
import type { ITransport } from '../../../vendor/agentplace-transport/Transport.ts';
import { RecordsClient } from './records-client.ts';

class OfflineTransport implements ITransport {
  isConnected = false;
  sent = 0;

  send(): void {
    this.sent += 1;
  }

  on(): void {}
}

const SETTLE_WINDOW_MS = 150;

/** Whether `promise` settles within the window, without leaving a rejection unhandled. */
async function settlesQuickly(promise: Promise<unknown>): Promise<boolean> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), SETTLE_WINDOW_MS)),
  ]);
  promise.catch(() => {});
  return outcome === 'settled';
}

describe('RecordsClient over a disconnected transport', () => {
  it('rejects the declarations read instead of holding the turn open', async () => {
    const transport = new OfflineTransport();
    const client = new RecordsClient(new RpcPeer(transport), { sessionId: 'sess_1' });

    await assert.rejects(() => client.listDeclarations(), /offline/i);
    assert.strictEqual(transport.sent, 0, 'nothing was put on the wire');
  });

  it('still buffers an ordinary record call — the reason the read has to be volatile', async () => {
    const client = new RecordsClient(new RpcPeer(new OfflineTransport()), { sessionId: 'sess_1' });

    assert.strictEqual(
      await settlesQuickly(client.query('bookings')),
      false,
      'a retryable records call waits for the socket, with no timeout of its own',
    );
  });
});
