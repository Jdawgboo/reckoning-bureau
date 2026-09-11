import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RecordsClient, RecordsClientError, type RecordsTransport } from './records-client.ts';

class FakeTransport implements RecordsTransport {
  requests: Record<string, unknown>[] = [];
  lastOptions: { timeout?: number } | undefined;
  response: unknown = {};

  async ask<T = unknown>(payload: unknown, options?: { timeout?: number }): Promise<T> {
    this.requests.push(payload as Record<string, unknown>);
    this.lastOptions = options;
    return this.response as T;
  }
}

function envelope(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const at = '2026-01-01T00:00:00.000Z';
  return { id, createdAt: at, updatedAt: at, version: 1, audit: [], ...fields };
}

describe('RecordsClient', () => {
  let transport: FakeTransport;
  let client: RecordsClient;

  beforeEach(() => {
    transport = new FakeTransport();
    client = new RecordsClient(transport, { sessionId: 'sess_1' });
  });

  it('sends records:create with sessionId and returns the stamped record', async () => {
    transport.response = { record: envelope('rsv_1', { guest: 'Ann' }) };
    const created = await client.create('reservations', 'rsv_1', { guest: 'Ann' });
    assert.strictEqual(created.id, 'rsv_1');
    assert.deepStrictEqual(transport.requests[0], {
      type: 'records:create',
      collection: 'reservations',
      id: 'rsv_1',
      value: { guest: 'Ann' },
      sessionId: 'sess_1',
    });
  });

  it('omits id on create when not supplied', async () => {
    transport.response = { record: envelope('res_abc12345') };
    await client.create('reservations', undefined, {});
    assert.strictEqual('id' in transport.requests[0], false);
  });

  it('omits sessionId when the client has none', async () => {
    const anonymous = new RecordsClient(transport);
    transport.response = { record: null };
    await anonymous.get('reservations', 'rsv_1');
    assert.strictEqual('sessionId' in transport.requests[0], false);
  });

  it('sends records:get and returns null for missing records', async () => {
    transport.response = { record: null };
    const record = await client.get('reservations', 'rsv_1');
    assert.strictEqual(record, null);
    assert.deepStrictEqual(transport.requests[0], {
      type: 'records:get',
      collection: 'reservations',
      id: 'rsv_1',
      sessionId: 'sess_1',
    });
  });

  it('sends records:update with patch and changeNote', async () => {
    transport.response = { record: envelope('rsv_1', { status: 'confirmed', version: 2 }) };
    const updated = await client.update('reservations', 'rsv_1', { status: 'confirmed' }, 'ok');
    assert.strictEqual(updated.status, 'confirmed');
    assert.deepStrictEqual(transport.requests[0], {
      type: 'records:update',
      collection: 'reservations',
      id: 'rsv_1',
      patch: { status: 'confirmed' },
      changeNote: 'ok',
      sessionId: 'sess_1',
    });
  });

  it('sends records:query and returns the page', async () => {
    transport.response = { records: [envelope('rsv_1')], nextCursor: 'CUR' };
    const page = await client.query('reservations', { limit: 1 });
    assert.strictEqual(page.records.length, 1);
    assert.strictEqual(page.nextCursor, 'CUR');
    assert.deepStrictEqual(transport.requests[0], {
      type: 'records:query',
      collection: 'reservations',
      query: { limit: 1 },
      sessionId: 'sess_1',
    });
  });

  it('surfaces { error, code } payloads as typed errors', async () => {
    transport.response = { error: 'Collection "secrets" is not available.', code: 'denied' };
    await assert.rejects(
      () => client.query('secrets', {}),
      (err) => err instanceof RecordsClientError && err.code === 'denied',
    );
  });

  it('defaults unknown error codes to invalid', async () => {
    transport.response = { error: 'boom', code: 'weird' };
    await assert.rejects(
      () => client.get('reservations', 'rsv_1'),
      (err) => err instanceof RecordsClientError && err.code === 'invalid',
    );
  });

  it('rejects malformed mutation responses as unavailable, not as bad input', async () => {
    transport.response = { ok: true };
    await assert.rejects(
      () => client.create('reservations', 'rsv_1', {}),
      (err) => err instanceof RecordsClientError && err.code === 'unavailable',
    );
  });

  it('fails cleanly without a transport', async () => {
    const offline = new RecordsClient(null);
    await assert.rejects(
      () => offline.get('reservations', 'rsv_1'),
      (err) => err instanceof RecordsClientError && err.code === 'unavailable',
    );
  });

  describe('listDeclarations', () => {
    it('normalizes the platform projection and drops unusable entries', async () => {
      transport.response = {
        collections: [
          {
            name: 'bookings',
            title: 'Bookings',
            ops: ['create', 'get', 'query', 'nonsense'],
            scope: 'session',
            schema: { type: 'object' },
          },
          { name: 'services', ops: ['get', 'query'], scope: 'all' },
          { ops: ['get'] },
        ],
      };
      assert.deepStrictEqual(await client.listDeclarations(), [
        {
          name: 'bookings',
          title: 'Bookings',
          ops: ['create', 'get', 'query'],
          scope: 'session',
          schema: { type: 'object' },
        },
        { name: 'services', ops: ['get', 'query'], scope: 'all' },
      ]);
    });

    it('rejects an unrecognized shape rather than reporting "no collections"', async () => {
      transport.response = { unexpected: true };
      await assert.rejects(
        () => client.listDeclarations(),
        (err) => err instanceof RecordsClientError && err.code === 'unavailable',
      );
    });

    it('asks with a short timeout and volatile, so an offline socket cannot hold the turn', async () => {
      transport.response = { collections: [] };
      await client.listDeclarations();
      assert.deepStrictEqual(transport.lastOptions, { timeout: 2_000, retry: false });
    });
  });
});
