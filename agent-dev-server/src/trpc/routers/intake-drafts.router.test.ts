import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createCallerFactory } from '../init';
import type { TRPCContext } from '../init';
import { createIntakeDraftsRouter } from './intake-drafts.router';

function makeContext(sessionKey: string, files = new Map<string, string>()) {
  const logged: Array<{ action: string; summary: string }> = [];
  const ctx = {
    storage: {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return Buffer.from(value, 'utf8');
      },
      writeFile: async (path: string, content: Buffer) => {
        files.set(path, content.toString('utf8'));
      },
    },
    actionLog: { append: (entry: { action: string; summary: string }) => logged.push(entry) },
    sessionKey,
    invalidate: () => undefined,
    records: {},
  } as unknown as TRPCContext;
  return { ctx, files, logged };
}

const caller = createCallerFactory(createIntakeDraftsRouter());

describe('deposit intake drafts', () => {
  it('reads each persisted detail back without replacing earlier answers', async () => {
    const { ctx, files } = makeContext('deposit-session');
    const api = caller(ctx);

    await api.updateDeposit({ counterpartyName: 'Whitfield Estates Ltd.' });
    await api.updateDeposit({ amountValue: 1400, currency: 'USD' });
    await api.updateDeposit({ moveOutDate: '31 January 2026' });
    await api.updateDeposit({
      withholdingNotice: '10 February 2026: the landlord said the full deposit would be retained for cleaning.',
    });
    await api.updateDeposit({ evidenceSummary: 'Check-out photographs and the withholding email.' });
    await api.updateDeposit({ remedySought: 'Return the full $1,400 deposit.' });

    const result = await api.getDeposit();
    assert.deepStrictEqual(result.draft && {
      counterpartyName: result.draft.counterpartyName,
      amountValue: result.draft.amountValue,
      currency: result.draft.currency,
      moveOutDate: result.draft.moveOutDate,
      withholdingNotice: result.draft.withholdingNotice,
      evidenceSummary: result.draft.evidenceSummary,
      remedySought: result.draft.remedySought,
    }, {
      counterpartyName: 'Whitfield Estates Ltd.',
      amountValue: 1400,
      currency: 'USD',
      moveOutDate: '31 January 2026',
      withholdingNotice: '10 February 2026: the landlord said the full deposit would be retained for cleaning.',
      evidenceSummary: 'Check-out photographs and the withholding email.',
      remedySought: 'Return the full $1,400 deposit.',
    });
    assert.strictEqual(files.size, 1);
  });

  it('does not expose one session’s unfiled draft to another session', async () => {
    const files = new Map<string, string>();
    const first = caller(makeContext('first-session', files).ctx);
    const second = caller(makeContext('second-session', files).ctx);

    await first.updateDeposit({ counterpartyName: 'Whitfield Estates Ltd.' });

    assert.strictEqual((await second.getDeposit()).draft, null);
  });
});
