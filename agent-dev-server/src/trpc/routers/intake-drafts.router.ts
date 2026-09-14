import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { TRPCContext } from '../init';
import { createRouter, publicProcedure } from '../init';
import { loggedProcedure } from '../middleware/action-logging';

const INTAKE_DRAFTS_DIR = 'common/intake-drafts';

export interface DepositIntakeDraft {
  kind: 'deposit-kept';
  createdAt: string;
  updatedAt: string;
  counterpartyName: string | null;
  amountValue: number | null;
  currency: string | null;
  moveOutDate: string | null;
  withholdingNotice: string | null;
  evidenceSummary: string | null;
  remedySought: string | null;
}

const updateDepositInput = z.object({
  counterpartyName: z.string().trim().min(1).max(200).optional(),
  amountValue: z.number().positive().max(10_000_000).optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  moveOutDate: z.string().trim().min(1).max(80).optional(),
  withholdingNotice: z.string().trim().min(1).max(2_000).optional(),
  evidenceSummary: z.string().trim().min(1).max(2_000).optional(),
  remedySought: z.string().trim().min(1).max(600).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one intake field is required.');

function draftPath(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey).digest('hex');
  return `${INTAKE_DRAFTS_DIR}/deposit-${digest}.json`;
}

async function readDraft(ctx: TRPCContext): Promise<DepositIntakeDraft | null> {
  try {
    const path = draftPath(ctx.sessionKey);
    if (!(await ctx.storage.exists(path))) return null;
    return JSON.parse((await ctx.storage.readFile(path)).toString('utf8')) as DepositIntakeDraft;
  } catch (error) {
    console.error('[intakeDrafts] read failed:', error);
    return null;
  }
}

async function writeDraft(ctx: TRPCContext, draft: DepositIntakeDraft): Promise<void> {
  await ctx.storage.writeFile(
    draftPath(ctx.sessionKey),
    Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, 'utf8'),
  );
}

function blankDepositDraft(now: string): DepositIntakeDraft {
  return {
    kind: 'deposit-kept',
    createdAt: now,
    updatedAt: now,
    counterpartyName: null,
    amountValue: null,
    currency: null,
    moveOutDate: null,
    withholdingNotice: null,
    evidenceSummary: null,
    remedySought: null,
  };
}

/**
 * An unfiled intake draft is deliberately separate from the public docket.
 * The screen writes each answer here before it advances, then reads this
 * server-held record back on every mount. A docket still exists only when the
 * claimant stamps the final CaseFile and cases.open succeeds.
 */
export function createIntakeDraftsRouter() {
  return createRouter({
    getDeposit: publicProcedure.query(async ({ ctx }) => ({
      draft: await readDraft(ctx),
    })),

    updateDeposit: loggedProcedure
      .input(updateDepositInput)
      .mutation(async ({ input, ctx }) => {
        const now = new Date().toISOString();
        const current = (await readDraft(ctx)) ?? blankDepositDraft(now);
        const next: DepositIntakeDraft = {
          ...current,
          ...input,
          currency: input.currency ? input.currency.toUpperCase() : current.currency,
          updatedAt: now,
        };
        await writeDraft(ctx, next);
        console.log('[intakeDrafts.updateDeposit] saved fields:', Object.keys(input));
        return {
          draft: next,
          logSummary: 'Deposit intake detail recorded in the unfiled working record.',
          logData: { fields: Object.keys(input) },
        };
      }),
  });
}
