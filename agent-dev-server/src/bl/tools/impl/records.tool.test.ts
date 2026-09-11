import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ToolExecuteContext } from '../../agent/agent-library.ts';
import { RecordsClient, type RecordsTransport } from '../../records/records-client.ts';
import type { CollectionDeclaration } from '../../../../vendor/agent-library/records/types.ts';
import { ManageRecordsTool } from './records.tool.ts';
import { isRecord } from '../../../util/type-guards.ts';

class ScriptedTransport implements RecordsTransport {
  response: unknown = {};
  failure: Error | null = null;

  async ask<T = unknown>(): Promise<T> {
    if (this.failure) {
      throw this.failure;
    }
    return this.response as T;
  }
}

function makeCtx(): ToolExecuteContext {
  return { runner: { state: undefined }, toolCallId: 'test-1' };
}

function makeTool(
  transport: ScriptedTransport,
  declarations: CollectionDeclaration[] = [],
): ManageRecordsTool {
  return new ManageRecordsTool(new RecordsClient(transport, { sessionId: 'sess_1' }), declarations);
}

function outputOf(output: unknown): Record<string, unknown> {
  assert.strictEqual(typeof output, 'string');
  const parsed: unknown = JSON.parse(String(output));
  assert.ok(isRecord(parsed));
  return parsed;
}

describe('ManageRecordsTool description', () => {
  it('carries the declared collections so the model does not learn them by failing', () => {
    const tool = makeTool(new ScriptedTransport(), [
      {
        name: 'bookings',
        ops: ['create'],
        scope: 'session',
        schema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['booked', 'canceled'] } },
          required: ['action'],
        },
      },
    ]);
    const description = tool.getDescription();
    assert.match(description, /## Your collections/);
    assert.match(description, /- action \(string, required\) — one of: booked, canceled/);
  });

  it('falls back to the static description when no declarations are known', () => {
    const description = makeTool(new ScriptedTransport()).getDescription();
    assert.ok(!description.includes('## Your collections'));
    assert.match(description, /Commands: query, get, create, update\./);
  });
});

describe('ManageRecordsTool failure surface', () => {
  it('marks a rejected write as unsaved and carries the code', async () => {
    const transport = new ScriptedTransport();
    transport.response = { error: 'Field "action" is required (string).', code: 'invalid' };

    const result = await makeTool(transport).execute(
      { command: 'create', collection: 'bookings', value: {} },
      makeCtx(),
    );

    assert.deepStrictEqual(outputOf(result.output), {
      error: 'Field "action" is required (string).',
      code: 'invalid',
      saved: false,
    });
  });

  it('marks a rejected update as unsaved', async () => {
    const transport = new ScriptedTransport();
    transport.response = { error: 'Record "bookings/b_1" not found.', code: 'not_found' };

    const result = await makeTool(transport).execute(
      { command: 'update', collection: 'bookings', id: 'b_1', patch: { status: 'x' } },
      makeCtx(),
    );

    assert.strictEqual(outputOf(result.output)['saved'], false);
  });

  it('does not claim anything about saving on a failed read', async () => {
    const transport = new ScriptedTransport();
    transport.response = { error: 'Collection "secrets" is not available.', code: 'denied' };

    const result = await makeTool(transport).execute(
      { command: 'query', collection: 'secrets' },
      makeCtx(),
    );

    assert.deepStrictEqual(outputOf(result.output), {
      error: 'Collection "secrets" is not available.',
      code: 'denied',
    });
  });

  it('throws a scrubbed error when the request never reached the records plane', async () => {
    // A thrown tool error is projected onto the visitor's screen, and the
    // platform wraps transport faults around raw backend text.
    const transport = new ScriptedTransport();
    transport.failure = new Error(
      '[AgentRecordsGate:records:create] DynamoDB: key /data/records/bookings/bok_1 failed',
    );

    await assert.rejects(
      () =>
        makeTool(transport).execute(
          { command: 'create', collection: 'bookings', value: { action: 'booked' } },
          makeCtx(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /did not confirm the create on "bookings"/);
        assert.match(err.message, /may or may not have been saved/);
        assert.ok(!err.message.includes('DynamoDB'));
        assert.ok(!err.message.includes('/data/records/'));
        assert.ok(err.cause instanceof Error, 'the real cause is kept for the logs');
        return true;
      },
    );
  });

  it('does not claim a write failed when the answer simply never arrived', async () => {
    // A timeout can land after the record was committed. "Nothing was saved" is
    // the instruction that turns that into a duplicate booking.
    const transport = new ScriptedTransport();
    transport.failure = new Error('Timeout waiting for response');

    await assert.rejects(
      () =>
        makeTool(transport).execute(
          { command: 'update', collection: 'bookings', id: 'b_1', patch: { status: 'canceled' } },
          makeCtx(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!/nothing was saved/i.test(err.message));
        assert.match(err.message, /Read the record back/);
        return true;
      },
    );
  });

  it('says nothing about saving when a read never got an answer', async () => {
    const transport = new ScriptedTransport();
    transport.failure = new Error('Timeout waiting for response');

    await assert.rejects(
      () => makeTool(transport).execute({ command: 'query', collection: 'bookings' }, makeCtx()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(
          err.message,
          'The records service did not answer the query on "bookings".',
        );
        return true;
      },
    );
  });

  it('throws on a malformed platform response rather than reporting a lost write as handled', async () => {
    const transport = new ScriptedTransport();
    transport.response = { unexpected: true };

    await assert.rejects(
      () =>
        makeTool(transport).execute(
          { command: 'create', collection: 'bookings', value: { action: 'booked' } },
          makeCtx(),
        ),
      /did not confirm the create/,
    );
  });
});
