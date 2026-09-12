import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createCallerFactory } from '../init';
import type { TRPCContext } from '../init';
import { createCasesRouter, type CaseFileRecord, type CaseIndexEntry } from './cases.router';

/**
 * The registry's contract: docket numbers are minted server-side and sequential
 * per year, the stored file is what a later read returns, and a docket entry
 * appends without losing the record. An in-memory storage stub stands in for the
 * `common/` branch — the same read/write surface `ctx.storage` exposes.
 */

function makeContext(files = new Map<string, string>()) {
  const invalidated: string[] = [];
  const logged: Array<{ action: string; summary: string }> = [];
  const ctx = {
    storage: {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) {
          throw new Error(`missing ${path}`);
        }
        return Buffer.from(value, 'utf8');
      },
      writeFile: async (path: string, content: Buffer) => {
        files.set(path, content.toString('utf8'));
      },
    },
    actionLog: {
      append: (entry: { action: string; summary: string }) => {
        logged.push(entry);
      },
    },
    sessionKey: 'test-session',
    invalidate: (topic: string) => {
      invalidated.push(topic);
    },
    records: {},
  } as unknown as TRPCContext;
  return { ctx, files, invalidated, logged };
}

const caller = createCallerFactory(createCasesRouter());

const draft = {
  counterpartyName: 'Meridian Lettings Ltd',
  counterpartyKind: 'Letting agent',
  category: 'deposit-kept',
  summary: 'Tenancy ended 30 June. Deposit of £1,150 withheld without a schedule of deductions.',
  remedySought: 'Return of the full £1,150 deposit within 14 days.',
  amountValue: 1150,
  currency: 'GBP',
  chronology: [{ date: '30 Jun 2025', event: 'Tenancy ended; keys returned in person.' }],
  evidence: [{ label: 'Tenancy agreement', held: true }],
};

describe('cases registry', () => {
  it('mints sequential docket numbers and stores the file', async () => {
    const { ctx, files } = makeContext();
    const api = caller(ctx);

    const first = await api.open(draft);
    const second = await api.open({ ...draft, counterpartyName: 'Northwind Airways' });

    const year = new Date().getUTCFullYear();
    assert.strictEqual(first.case.docket, `RB-${year}-0001`);
    assert.strictEqual(second.case.docket, `RB-${year}-0002`);
    assert.strictEqual(first.case.status, 'received');
    assert.ok(files.has(`common/cases/RB-${year}-0001.json`));
    assert.deepStrictEqual(first.case.docketEntries[0].stamp, 'RECEIVED');
  });

  it('reads a stored file back by docket and rejects a foreign key', async () => {
    const { ctx } = makeContext();
    const api = caller(ctx);

    const opened = await api.open(draft);
    const fetched = (await api.get({ docket: opened.case.docket })) as CaseFileRecord | null;

    assert.strictEqual(fetched?.counterpartyName, 'Meridian Lettings Ltd');
    assert.strictEqual(fetched?.amountValue, 1150);
    assert.strictEqual(await api.get({ docket: '../../etc/passwd' }), null);
    assert.strictEqual(await api.get({ docket: 'RB-2025-9999' }), null);
  });

  it('appends a docket entry and moves the status without losing the file', async () => {
    const { ctx } = makeContext();
    const api = caller(ctx);

    const opened = await api.open(draft);
    const updated = await api.addEntry({
      docket: opened.case.docket,
      stamp: 'demand issued',
      note: 'Letter before action issued to the agent; 14 days to respond.',
      status: 'demand_issued',
      nextActionLabel: 'Escalate to deposit scheme if no reply',
      nextActionDueAt: '2025-10-01',
    });

    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.case?.status, 'demand_issued');
    assert.strictEqual(updated.case?.docketEntries.length, 2);
    assert.strictEqual(updated.case?.docketEntries[1].stamp, 'DEMAND ISSUED');
    assert.strictEqual(updated.case?.counterpartyName, 'Meridian Lettings Ltd');
    assert.strictEqual(updated.case?.nextActionLabel, 'Escalate to deposit scheme if no reply');
  });

  it('stops the clock when the file escalates', async () => {
    const { ctx } = makeContext();
    const api = caller(ctx);

    const opened = await api.open(draft);
    await api.addEntry({
      docket: opened.case.docket,
      stamp: 'DEMAND ISSUED',
      note: 'Letter before action issued.',
      status: 'demand_issued',
      nextActionLabel: 'Await response',
      nextActionDueAt: '2025-10-01',
    });
    // What the escalation pack sends when the claimant lodges: an explicit null
    // must clear the due date, not be mistaken for "leave it as it was".
    const escalated = await api.addEntry({
      docket: opened.case.docket,
      stamp: 'REFERRED TO REGULATOR',
      note: 'Referred to the deposit protection scheme by the claimant.',
      status: 'escalated',
      nextActionLabel: 'Await the outcome from the scheme',
      nextActionDueAt: null,
    });

    assert.strictEqual(escalated.ok, true);
    assert.strictEqual(escalated.case?.status, 'escalated');
    assert.strictEqual(escalated.case?.nextActionDueAt, null);
    assert.strictEqual(escalated.case?.docketEntries.length, 3);
    assert.strictEqual(escalated.case?.docketEntries.at(-1)?.stamp, 'REFERRED TO REGULATOR');
  });

  it('reports an unknown docket instead of creating one', async () => {    const { ctx } = makeContext();
    const api = caller(ctx);

    const result = await api.addEntry({
      docket: 'RB-2025-4242',
      stamp: 'ESCALATED',
      note: 'Nothing should happen here.',
    });

    assert.strictEqual(result.ok, false);
  });

  it('keeps a newest-first index of the register', async () => {
    const { ctx } = makeContext();
    const api = caller(ctx);

    await api.open(draft);
    const second = await api.open({ ...draft, counterpartyName: 'Northwind Airways' });
    const index = (await api.recent()) as CaseIndexEntry[];

    assert.strictEqual(index.length, 2);
    assert.strictEqual(index[0].docket, second.case.docket);
    assert.strictEqual(index[0].counterpartyName, 'Northwind Airways');
  });

  it('compares sealed figures on the server without exposing either figure in docket reads', async () => {
    process.env.SETTLEMENT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
    const { ctx, files } = makeContext();
    const api = caller(ctx);
    const opened = await api.open(draft);
    await api.addEntry({
      docket: opened.case.docket,
      stamp: 'DEMAND ISSUED',
      note: 'Letter before action issued.',
      status: 'demand_issued',
    });

    const started = await api.startSettlement({ docket: opened.case.docket });
    assert.strictEqual(started.ok, true);
    if (!started.ok) return;

    const claimant = await api.redeemSettlementInvite({ code: started.claimantCode });
    const respondent = await api.redeemSettlementInvite({ code: started.respondentCode });
    assert.deepStrictEqual(claimant, { ok: true, docket: opened.case.docket, role: 'claimant' });
    assert.deepStrictEqual(respondent, { ok: true, docket: opened.case.docket, role: 'respondent' });

    const claimantFirst = await api.submitSealedFigure({ accessCode: started.claimantCode, amount: 1110 });
    assert.strictEqual(claimantFirst.ok, true);
    assert.strictEqual(claimantFirst.state, 'sealed');

    const noZone = await api.submitSealedFigure({ accessCode: started.respondentCode, amount: 900 });
    assert.strictEqual(noZone.ok, true);
    assert.strictEqual(noZone.state, 'no_zone');
    assert.strictEqual('settledAmount' in noZone && noZone.settledAmount, null);

    await api.submitSealedFigure({ accessCode: started.claimantCode, amount: 1110 });
    const settlement = await api.submitSealedFigure({ accessCode: started.respondentCode, amount: 1170 });
    assert.strictEqual(settlement.ok, true);
    assert.strictEqual(settlement.state, 'settled');
    assert.strictEqual(settlement.settledAmount, 1140);

    const publicCase = await api.get({ docket: opened.case.docket });
    assert.strictEqual(publicCase?.status, 'resolved');
    assert.deepStrictEqual(publicCase?.outcome, { routeUsed: 'zopa', amountRecovered: 1140 });
    assert.strictEqual(JSON.stringify(publicCase).includes('1110'), false);
    assert.strictEqual(JSON.stringify(publicCase).includes('1170'), false);
    assert.strictEqual(files.get(`common/cases/${opened.case.docket}.json`)?.includes('1110'), false);
    assert.strictEqual(files.get(`common/cases/${opened.case.docket}.json`)?.includes('1170'), false);
  });

  it('destroys sealed figures after the third non-overlapping round and preserves enforcement timing', async () => {
    process.env.SETTLEMENT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64url');
    const { ctx, files } = makeContext();
    const api = caller(ctx);
    const opened = await api.open(draft);
    await api.addEntry({
      docket: opened.case.docket,
      stamp: 'DEMAND ISSUED',
      note: 'Letter before action issued.',
      status: 'demand_issued',
      nextActionDueAt: '2026-10-01',
    });
    const started = await api.startSettlement({ docket: opened.case.docket });
    assert.strictEqual(started.ok, true);
    if (!started.ok) return;

    for (let round = 0; round < 3; round += 1) {
      const claimant = await api.submitSealedFigure({ accessCode: started.claimantCode, amount: 1110 });
      assert.strictEqual(claimant.ok, true);
      const respondent = await api.submitSealedFigure({ accessCode: started.respondentCode, amount: 900 });
      assert.strictEqual(respondent.ok, true);
      if (round < 2) assert.strictEqual(respondent.state, 'no_zone');
      else assert.strictEqual(respondent.state, 'exhausted');
    }

    const publicCase = await api.get({ docket: opened.case.docket });
    assert.strictEqual(publicCase?.status, 'demand_issued');
    assert.strictEqual(publicCase?.nextActionDueAt, '2026-10-01');
    assert.strictEqual(publicCase?.docketEntries.at(-1)?.stamp, 'SEALED SETTLEMENT EXHAUSTED');
    const storedSettlement = files.get(`common/cases/${opened.case.docket}.settlement.json`) ?? '';
    assert.strictEqual(storedSettlement.includes('1110'), false);
    assert.strictEqual(storedSettlement.includes('900'), false);
  });

  it('runs a clearly flagged demonstration clock without changing the real deadline field', async () => {
    const { ctx } = makeContext();
    const api = caller(ctx);
    const opened = await api.open(draft);
    await api.addEntry({
      docket: opened.case.docket,
      stamp: 'DEMAND ISSUED',
      note: 'Letter before action issued.',
      status: 'demand_issued',
      nextActionDueAt: '2026-10-01',
    });

    const started = await api.startDemoClock({ docket: opened.case.docket, seconds: 8 });
    assert.strictEqual(started.ok, true);
    const completed = await api.completeDemoClock({ docket: opened.case.docket });
    assert.strictEqual(completed.ok, true);
    assert.strictEqual(completed.case?.flags.demo, true);
    assert.strictEqual(completed.case?.clock.tempo, 'demo');
    assert.strictEqual(completed.case?.nextActionDueAt, '2026-10-01');
    assert.strictEqual(completed.case?.docketEntries.at(-1)?.stamp, 'DEADLINE ELAPSED');
  });
});
