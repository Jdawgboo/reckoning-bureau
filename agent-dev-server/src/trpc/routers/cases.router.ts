import { z } from 'zod';
import { createRouter, publicProcedure } from '../init';
import { loggedProcedure } from '../middleware/action-logging';
import type { TRPCContext } from '../init';

/**
 * The Bureau's registry: durable case files, docket numbers, docket entries.
 *
 * Cases live as JSON under the shared `common/` storage branch, so a docket
 * outlives the session that opened it, is readable by a scheduled escalation
 * run, and can be read back by the agent's own `filesystem` tool at
 * `common/cases/<docket>.json`. The docket number is minted server-side from a
 * sequence file — the visitor's file number is never invented by the model.
 */

const CASES_DIR = 'common/cases';
const SEQUENCE_PATH = `${CASES_DIR}/_sequence.json`;
const INDEX_PATH = `${CASES_DIR}/_index.json`;

export const CASE_STATUSES = [
  'received',
  'demand_issued',
  'escalated',
  'resolved',
  'withdrawn',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface DocketEntry {
  at: string;
  stamp: string;
  note: string;
}

export interface CaseFileRecord {
  docket: string;
  openedAt: string;
  updatedAt: string;
  status: CaseStatus;
  claimantName: string | null;
  claimantContact: string | null;
  counterpartyName: string;
  counterpartyKind: string | null;
  category: string;
  summary: string;
  remedySought: string;
  amountValue: number | null;
  currency: string | null;
  chronology: Array<{ date: string | null; event: string }>;
  evidence: Array<{ label: string; held: boolean; detail: string | null }>;
  docketEntries: DocketEntry[];
  nextActionLabel: string | null;
  nextActionDueAt: string | null;
  artifacts: Array<{ kind: string; path: string; issuedAt: string }>;
}

export interface CaseIndexEntry {
  docket: string;
  counterpartyName: string;
  status: CaseStatus;
  openedAt: string;
  summary: string;
}

const chronologyItem = z.object({
  date: z.string().max(40).nullish(),
  event: z.string().min(1).max(400),
});

const evidenceItem = z.object({
  label: z.string().min(1).max(160),
  held: z.boolean().default(false),
  detail: z.string().max(400).nullish(),
});

const openInput = z.object({
  counterpartyName: z.string().min(1).max(200),
  counterpartyKind: z.string().max(80).nullish(),
  category: z.string().min(1).max(60),
  summary: z.string().min(1).max(2000),
  remedySought: z.string().min(1).max(600),
  amountValue: z.number().nonnegative().nullish(),
  currency: z.string().max(8).nullish(),
  claimantName: z.string().max(160).nullish(),
  claimantContact: z.string().max(200).nullish(),
  chronology: z.array(chronologyItem).max(40).default([]),
  evidence: z.array(evidenceItem).max(40).default([]),
});

function casePath(docket: string): string {
  return `${CASES_DIR}/${docket}.json`;
}

/** Dockets are the only key here, so nothing but our own format may be read. */
function isDocket(value: string): boolean {
  return /^RB-\d{4}-\d{4}$/.test(value);
}

async function readJson<T>(ctx: TRPCContext, path: string): Promise<T | null> {
  try {
    if (!(await ctx.storage.exists(path))) {
      return null;
    }
    const buffer = await ctx.storage.readFile(path);
    return JSON.parse(buffer.toString('utf8')) as T;
  } catch (error) {
    console.error(`[cases] read failed for ${path}:`, error);
    return null;
  }
}

async function writeJson(ctx: TRPCContext, path: string, value: unknown): Promise<void> {
  await ctx.storage.writeFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/** Mints the next docket number: RB-<year>-<4-digit sequence>. */
async function mintDocket(ctx: TRPCContext): Promise<string> {
  const year = new Date().getUTCFullYear();
  const current = await readJson<{ year: number; seq: number }>(ctx, SEQUENCE_PATH);
  const seq = current && current.year === year ? current.seq + 1 : 1;
  await writeJson(ctx, SEQUENCE_PATH, { year, seq });
  return `RB-${year}-${String(seq).padStart(4, '0')}`;
}

async function updateIndex(ctx: TRPCContext, file: CaseFileRecord): Promise<void> {
  const index = (await readJson<CaseIndexEntry[]>(ctx, INDEX_PATH)) ?? [];
  const entry: CaseIndexEntry = {
    docket: file.docket,
    counterpartyName: file.counterpartyName,
    status: file.status,
    openedAt: file.openedAt,
    summary: file.summary.slice(0, 200),
  };
  const next = [entry, ...index.filter((row) => row.docket !== file.docket)].slice(0, 200);
  await writeJson(ctx, INDEX_PATH, next);
}

async function persist(ctx: TRPCContext, file: CaseFileRecord): Promise<CaseFileRecord> {
  const saved: CaseFileRecord = { ...file, updatedAt: new Date().toISOString() };
  await writeJson(ctx, casePath(saved.docket), saved);
  await updateIndex(ctx, saved);
  return saved;
}

export function createCasesRouter() {
  return createRouter({
    /** Read one docket. Public: the docket number is the key. */
    get: publicProcedure
      .input(z.object({ docket: z.string().min(1).max(40) }))
      .query(async ({ input, ctx }) => {
        if (!isDocket(input.docket)) {
          return null;
        }
        return await readJson<CaseFileRecord>(ctx, casePath(input.docket));
      }),

    /** The registry index, newest first — what the office has on file. */
    recent: publicProcedure
      .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).optional())
      .query(async ({ input, ctx }) => {
        const index = (await readJson<CaseIndexEntry[]>(ctx, INDEX_PATH)) ?? [];
        return index.slice(0, input?.limit ?? 10);
      }),

    /** Stamp RECEIVED: mint a docket number and commit the file to the registry. */
    open: loggedProcedure.input(openInput).mutation(async ({ input, ctx }) => {
      console.log('[cases.open] input:', {
        counterparty: input.counterpartyName,
        category: input.category,
      });
      try {
        const docket = await mintDocket(ctx);
        const now = new Date().toISOString();
        const file: CaseFileRecord = {
          docket,
          openedAt: now,
          updatedAt: now,
          status: 'received',
          claimantName: input.claimantName ?? null,
          claimantContact: input.claimantContact ?? null,
          counterpartyName: input.counterpartyName,
          counterpartyKind: input.counterpartyKind ?? null,
          category: input.category,
          summary: input.summary,
          remedySought: input.remedySought,
          amountValue: input.amountValue ?? null,
          currency: input.currency ?? null,
          chronology: input.chronology.map((row) => ({
            date: row.date ?? null,
            event: row.event,
          })),
          evidence: input.evidence.map((row) => ({
            label: row.label,
            held: row.held,
            detail: row.detail ?? null,
          })),
          docketEntries: [
            { at: now, stamp: 'RECEIVED', note: 'File opened at intake. Case under review.' },
          ],
          nextActionLabel: null,
          nextActionDueAt: null,
          artifacts: [],
        };
        const saved = await persist(ctx, file);
        return {
          case: saved,
          logSummary:
            `Case file ${saved.docket} opened against ${saved.counterpartyName} ` +
            `(${saved.category}); status received.`,
          logData: { docket: saved.docket, status: saved.status },
        };
      } catch (error) {
        console.error('[cases.open] failed:', error);
        throw error;
      }
    }),

    /** Append a docket entry, optionally moving the file's status. */
    addEntry: loggedProcedure
      .input(
        z.object({
          docket: z.string().min(1).max(40),
          stamp: z.string().min(1).max(40),
          note: z.string().min(1).max(600),
          status: z.enum(CASE_STATUSES).optional(),
          nextActionLabel: z.string().max(200).nullish(),
          nextActionDueAt: z.string().max(40).nullish(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const file = isDocket(input.docket)
          ? await readJson<CaseFileRecord>(ctx, casePath(input.docket))
          : null;
        if (!file) {
          return { ok: false as const, logSummary: `No case file found for ${input.docket}.` };
        }
        const entry: DocketEntry = {
          at: new Date().toISOString(),
          stamp: input.stamp.toUpperCase(),
          note: input.note,
        };
        const saved = await persist(ctx, {
          ...file,
          status: input.status ?? file.status,
          nextActionLabel:
            input.nextActionLabel === undefined ? file.nextActionLabel : input.nextActionLabel,
          nextActionDueAt:
            input.nextActionDueAt === undefined ? file.nextActionDueAt : input.nextActionDueAt,
          docketEntries: [...file.docketEntries, entry].slice(-60),
        });
        return {
          ok: true as const,
          case: saved,
          logSummary: `${saved.docket}: ${entry.stamp} — ${entry.note}`,
          logData: { docket: saved.docket, status: saved.status },
        };
      }),
  });
}
