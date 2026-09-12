import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';
import { createRouter, publicProcedure } from '../init';
import { loggedProcedure } from '../middleware/action-logging';
import type { TRPCContext } from '../init';

/**
 * The Bureau's durable registry.
 *
 * Public docket reads retain the original docket-keyed access model. Confidential
 * settlement figures are intentionally NOT part of that record: their encrypted
 * store has capability-code access only, and the public `get` procedure never
 * reads it. This keeps both sealed figures out of ordinary case reads, UI state,
 * action logs, artefacts and LLM context.
 */

const CASES_DIR = 'common/cases';
const SEQUENCE_PATH = `${CASES_DIR}/_sequence.json`;
const INDEX_PATH = `${CASES_DIR}/_index.json`;
const SETTLEMENT_ACCESS_PATH = `${CASES_DIR}/_settlement_access.json`;

export const CASE_STATUSES = [
  'received',
  'demand_issued',
  'escalated',
  'resolved',
  'withdrawn',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
type SettlementRole = 'claimant' | 'respondent';
type SettlementState = 'invited' | 'settled' | 'exhausted';

export interface DocketEntry {
  at: string;
  stamp: string;
  note: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: 'Registrar';
  event: string;
  result: 'sealed' | 'no_zone' | 'settled' | 'exhausted';
  floorHash?: string;
  ceilingHash?: string;
  prevHash: string | null;
  entryHash: string;
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
  clock: {
    tempo: 'real' | 'demo';
    demoStartedAt: string | null;
    demoDurationSeconds: number | null;
  };
  flags: { demo: boolean };
  outcome: { routeUsed: string | null; amountRecovered: number | null };
  auditTrail: AuditEntry[];
}

export interface CaseIndexEntry {
  docket: string;
  counterpartyName: string;
  status: CaseStatus;
  openedAt: string;
  summary: string;
}

interface SealedBid {
  amountCiphertext: string;
  submittedAt: string;
}

interface SettlementParticipant {
  accessHash: string;
  bid: SealedBid | null;
}

interface SettlementRecord {
  docket: string;
  currency: string;
  state: SettlementState;
  round: number;
  roundsRun: number;
  lastResult: 'none' | 'no_zone' | 'settled' | 'exhausted';
  settledAmount: number | null;
  claimant: SettlementParticipant;
  respondent: SettlementParticipant;
  createdAt: string;
  updatedAt: string;
}

interface SettlementAccessEntry {
  docket: string;
  role: SettlementRole;
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

const accessCodeInput = z.object({
  accessCode: z.string().min(20).max(180),
});

function casePath(docket: string): string {
  return `${CASES_DIR}/${docket}.json`;
}

function settlementPath(docket: string): string {
  return `${CASES_DIR}/${docket}.settlement.json`;
}

/** Dockets are the only key for ordinary registry reads. */
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

function settlementEncryptionKey(): Buffer {
  const encoded = process.env.SETTLEMENT_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error('Confidential settlement is not configured.');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) {
    throw new Error('Confidential settlement is misconfigured.');
  }
  return key;
}

function encryptAmount(amount: number): string {
  const key = settlementEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(amount), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptAmount(ciphertext: string): number {
  const [ivText, tagText, bodyText] = ciphertext.split('.');
  if (!ivText || !tagText || !bodyText) {
    throw new Error('Confidential settlement data is invalid.');
  }
  const decipher = createDecipheriv('aes-256-gcm', settlementEncryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(bodyText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const amount = Number(plain);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Confidential settlement data is invalid.');
  }
  return amount;
}

/** Capability codes are high-entropy. Their stored hashes grant no portal access. */
function hashAccessCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** HMAC protects a low-entropy bid from offline guessing through the audit log. */
function hashFigure(amount: number): string {
  return createHmac('sha256', settlementEncryptionKey()).update(String(amount)).digest('hex');
}

function mintAccessCode(): string {
  return `RB-S-${randomBytes(24).toString('base64url')}`;
}

function settlementView(record: SettlementRecord, role: SettlementRole) {
  const ownSubmitted = record[role].bid !== null;
  if (record.state === 'settled') {
    return {
      state: 'settled' as const,
      round: record.round,
      roundsRun: record.roundsRun,
      currency: record.currency,
      settledAmount: record.settledAmount,
    };
  }
  if (record.state === 'exhausted') {
    return {
      state: 'exhausted' as const,
      round: record.round,
      roundsRun: record.roundsRun,
      currency: record.currency,
      settledAmount: null,
    };
  }
  if (ownSubmitted) {
    return {
      state: 'sealed' as const,
      round: record.round,
      roundsRun: record.roundsRun,
      currency: record.currency,
      settledAmount: null,
    };
  }
  if (record.lastResult === 'no_zone') {
    return {
      state: 'no_zone' as const,
      round: record.round,
      roundsRun: record.roundsRun,
      currency: record.currency,
      settledAmount: null,
    };
  }
  return {
    state: 'ready' as const,
    round: record.round,
    roundsRun: record.roundsRun,
    currency: record.currency,
    settledAmount: null,
  };
}

async function getAccessEntry(ctx: TRPCContext, accessCode: string): Promise<SettlementAccessEntry | null> {
  const index = (await readJson<Record<string, SettlementAccessEntry>>(ctx, SETTLEMENT_ACCESS_PATH)) ?? {};
  return index[hashAccessCode(accessCode)] ?? null;
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

/** Mints the next docket number: RB-<year>-<4-digit sequence>. */
async function mintDocket(ctx: TRPCContext): Promise<string> {
  const year = new Date().getUTCFullYear();
  const current = await readJson<{ year: number; seq: number }>(ctx, SEQUENCE_PATH);
  const seq = current && current.year === year ? current.seq + 1 : 1;
  await writeJson(ctx, SEQUENCE_PATH, { year, seq });
  return `RB-${year}-${String(seq).padStart(4, '0')}`;
}

function appendAudit(
  file: CaseFileRecord,
  input: Omit<AuditEntry, 'seq' | 'prevHash' | 'entryHash'>,
): CaseFileRecord {
  const last = file.auditTrail.at(-1);
  const entryBase = {
    seq: (last?.seq ?? 0) + 1,
    at: input.at,
    actor: input.actor,
    event: input.event,
    result: input.result,
    ...(input.floorHash ? { floorHash: input.floorHash } : {}),
    ...(input.ceilingHash ? { ceilingHash: input.ceilingHash } : {}),
    prevHash: last?.entryHash ?? null,
  };
  const entryHash = createHmac('sha256', settlementEncryptionKey())
    .update(JSON.stringify(entryBase))
    .digest('hex');
  return { ...file, auditTrail: [...file.auditTrail, { ...entryBase, entryHash }].slice(-80) };
}

export function createCasesRouter() {
  return createRouter({
    /** Read one docket. Confidential settlement data lives outside this response. */
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
          clock: { tempo: 'real', demoStartedAt: null, demoDurationSeconds: null },
          flags: { demo: false },
          outcome: { routeUsed: null, amountRecovered: null },
          auditTrail: [],
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

    /** Starts an explicitly labelled, local demo clock. Real clocks still use schedules. */
    startDemoClock: loggedProcedure
      .input(z.object({ docket: z.string().min(1).max(40), seconds: z.number().int().min(8).max(60).default(16) }))
      .mutation(async ({ input, ctx }) => {
        const file = isDocket(input.docket)
          ? await readJson<CaseFileRecord>(ctx, casePath(input.docket))
          : null;
        if (!file || file.status !== 'demand_issued') {
          return { ok: false as const, logSummary: `Demo clock unavailable for ${input.docket}.` };
        }
        const now = new Date().toISOString();
        const saved = await persist(ctx, {
          ...file,
          clock: { tempo: 'demo', demoStartedAt: now, demoDurationSeconds: input.seconds },
          flags: { ...file.flags, demo: true },
          nextActionLabel: 'Accelerated demonstration clock running',
          docketEntries: [
            ...file.docketEntries,
            { at: now, stamp: 'DEMONSTRATION', note: 'Accelerated preview clock started. Real document dates remain unchanged.' },
          ].slice(-60),
        });
        return {
          ok: true as const,
          case: saved,
          startedAt: now,
          seconds: input.seconds,
          logSummary: `${saved.docket}: demonstration clock started.`,
          logData: { docket: saved.docket, tempo: 'demo' },
        };
      }),

    /** Called by the visible demo clock only; it never changes printed document dates. */
    completeDemoClock: loggedProcedure
      .input(z.object({ docket: z.string().min(1).max(40) }))
      .mutation(async ({ input, ctx }) => {
        const file = isDocket(input.docket)
          ? await readJson<CaseFileRecord>(ctx, casePath(input.docket))
          : null;
        if (!file || file.clock.tempo !== 'demo') {
          return { ok: false as const, logSummary: `No demonstration clock is active for ${input.docket}.` };
        }
        const now = new Date().toISOString();
        const saved = await persist(ctx, {
          ...file,
          nextActionLabel: 'Deadline elapsed — escalation draft ready',
          docketEntries: [
            ...file.docketEntries,
            { at: now, stamp: 'DEADLINE ELAPSED', note: 'Demonstration clock reached zero. Escalation drafting requested.' },
          ].slice(-60),
        });
        return {
          ok: true as const,
          case: saved,
          logSummary: `${saved.docket}: demonstration deadline elapsed.`,
          logData: { docket: saved.docket, tempo: 'demo' },
        };
      }),

    /**
     * Creates two role-specific capability codes. The claimant code and the
     * respondent code are returned only to the browser that starts the process;
     * only their hashes are retained server-side.
     */
    startSettlement: loggedProcedure
      .input(z.object({ docket: z.string().min(1).max(40) }))
      .mutation(async ({ input, ctx }) => {
        const file = isDocket(input.docket)
          ? await readJson<CaseFileRecord>(ctx, casePath(input.docket))
          : null;
        if (!file || file.status !== 'demand_issued') {
          return { ok: false as const, reason: 'unavailable', logSummary: `Settlement unavailable for ${input.docket}.` };
        }
        const existing = await readJson<SettlementRecord>(ctx, settlementPath(input.docket));
        if (existing) {
          return { ok: false as const, reason: 'already_started', logSummary: `Settlement already opened for ${input.docket}.` };
        }
        const claimantCode = mintAccessCode();
        const respondentCode = mintAccessCode();
        const now = new Date().toISOString();
        const settlement: SettlementRecord = {
          docket: file.docket,
          currency: file.currency ?? 'USD',
          state: 'invited',
          round: 1,
          roundsRun: 0,
          lastResult: 'none',
          settledAmount: null,
          claimant: { accessHash: hashAccessCode(claimantCode), bid: null },
          respondent: { accessHash: hashAccessCode(respondentCode), bid: null },
          createdAt: now,
          updatedAt: now,
        };
        const access = (await readJson<Record<string, SettlementAccessEntry>>(ctx, SETTLEMENT_ACCESS_PATH)) ?? {};
        access[settlement.claimant.accessHash] = { docket: file.docket, role: 'claimant' };
        access[settlement.respondent.accessHash] = { docket: file.docket, role: 'respondent' };
        await writeJson(ctx, settlementPath(file.docket), settlement);
        await writeJson(ctx, SETTLEMENT_ACCESS_PATH, access);
        const saved = await persist(ctx, {
          ...file,
          docketEntries: [
            ...file.docketEntries,
            { at: now, stamp: 'SEALED SETTLEMENT OPEN', note: 'Private settlement invitations created. No figures entered.' },
          ].slice(-60),
        });
        return {
          ok: true as const,
          claimantCode,
          respondentCode,
          currency: settlement.currency,
          logSummary: `${saved.docket}: sealed settlement invitations created.`,
          logData: { docket: saved.docket },
        };
      }),

    /** Resolves an opaque role code without returning any claimant case data. */
    redeemSettlementInvite: loggedProcedure
      .input(z.object({ code: z.string().min(20).max(180) }))
      .mutation(async ({ input, ctx }) => {
        const access = await getAccessEntry(ctx, input.code);
        if (!access) {
          return { ok: false as const, logSummary: 'Invalid sealed settlement invitation.' };
        }
        console.log('[cases.redeemSettlementInvite] access granted:', { docket: access.docket, role: access.role });
        return {
          ok: true as const,
          docket: access.docket,
          role: access.role,
          logSummary: `Sealed settlement invitation opened for ${access.docket}.`,
          logData: { docket: access.docket, role: access.role },
        };
      }),

    /** Shows only the caller's safe settlement state. Figures never leave the server. */
    settlementStatus: publicProcedure.input(accessCodeInput).query(async ({ input, ctx }) => {
      const access = await getAccessEntry(ctx, input.accessCode);
      if (!access) {
        return null;
      }
      const settlement = await readJson<SettlementRecord>(ctx, settlementPath(access.docket));
      if (!settlement || settlement[access.role].accessHash !== hashAccessCode(input.accessCode)) {
        return null;
      }
      return { docket: settlement.docket, role: access.role, ...settlementView(settlement, access.role) };
    }),

    /**
     * The comparison runs in this deterministic server mutation, rather than in
     * the model or the browser. It returns a result only — never either figure.
     */
    submitSealedFigure: loggedProcedure
      .input(accessCodeInput.extend({ amount: z.number().finite().nonnegative().max(100_000_000) }))
      .mutation(async ({ input, ctx }) => {
        const access = await getAccessEntry(ctx, input.accessCode);
        if (!access) {
          return { ok: false as const, reason: 'invalid_access', logSummary: 'Invalid sealed settlement access.' };
        }
        const settlement = await readJson<SettlementRecord>(ctx, settlementPath(access.docket));
        const file = await readJson<CaseFileRecord>(ctx, casePath(access.docket));
        if (!settlement || !file || settlement[access.role].accessHash !== hashAccessCode(input.accessCode)) {
          return { ok: false as const, reason: 'invalid_access', logSummary: 'Invalid sealed settlement access.' };
        }
        if (settlement.state !== 'invited') {
          return { ok: false as const, reason: settlement.state, ...settlementView(settlement, access.role), logSummary: `${access.docket}: settlement is closed.` };
        }
        if (settlement[access.role].bid) {
          return { ok: false as const, reason: 'already_submitted', ...settlementView(settlement, access.role), logSummary: `${access.docket}: sealed figure already submitted.` };
        }

        const now = new Date().toISOString();
        const next: SettlementRecord = {
          ...settlement,
          lastResult: 'none',
          updatedAt: now,
          [access.role]: {
            ...settlement[access.role],
            bid: { amountCiphertext: encryptAmount(input.amount), submittedAt: now },
          },
        };
        const otherRole: SettlementRole = access.role === 'claimant' ? 'respondent' : 'claimant';
        const otherBid = next[otherRole].bid;

        console.log('[cases.submitSealedFigure] received:', {
          docket: next.docket,
          role: access.role,
          round: next.round,
        });

        if (!otherBid) {
          await writeJson(ctx, settlementPath(next.docket), next);
          return {
            ok: true as const,
            ...settlementView(next, access.role),
            logSummary: `${next.docket}: ${access.role} sealed a settlement figure.`,
            logData: { docket: next.docket, role: access.role, round: next.round },
          };
        }

        const claimantBid = decryptAmount(next.claimant.bid!.amountCiphertext);
        const respondentBid = decryptAmount(next.respondent.bid!.amountCiphertext);
        const floorHash = hashFigure(claimantBid);
        const ceilingHash = hashFigure(respondentBid);
        const roundsRun = next.roundsRun + 1;

        if (respondentBid >= claimantBid) {
          const settledAmount = Math.round(((claimantBid + respondentBid) / 2) / 10) * 10;
          const settled: SettlementRecord = {
            ...next,
            state: 'settled',
            roundsRun,
            lastResult: 'settled',
            settledAmount,
            updatedAt: now,
          };
          await writeJson(ctx, settlementPath(settled.docket), settled);
          const audited = appendAudit(file, {
            at: now,
            actor: 'Registrar',
            event: `zopa_round_${next.round}`,
            result: 'settled',
            floorHash,
            ceilingHash,
          });
          const saved = await persist(ctx, {
            ...audited,
            status: 'resolved',
            outcome: { routeUsed: 'zopa', amountRecovered: settledAmount },
            nextActionLabel: 'Settled by agreement',
            nextActionDueAt: null,
            docketEntries: [
              ...audited.docketEntries,
              { at: now, stamp: 'SETTLED BY AGREEMENT', note: 'Resolved through confidential range comparison. Individual figures remain sealed.' },
            ].slice(-60),
          });
          return {
            ok: true as const,
            ...settlementView(settled, access.role),
            logSummary: `${saved.docket}: settled by confidential agreement.`,
            logData: { docket: saved.docket, route: 'zopa' },
          };
        }

        const exhausted = roundsRun >= 3;
        const reset: SettlementRecord = {
          ...next,
          state: exhausted ? 'exhausted' : 'invited',
          round: exhausted ? next.round : next.round + 1,
          roundsRun,
          lastResult: exhausted ? 'exhausted' : 'no_zone',
          claimant: { ...next.claimant, bid: null },
          respondent: { ...next.respondent, bid: null },
          updatedAt: now,
        };
        await writeJson(ctx, settlementPath(reset.docket), reset);
        const audited = appendAudit(file, {
          at: now,
          actor: 'Registrar',
          event: exhausted ? 'zopa_exhausted' : `zopa_round_${next.round}`,
          result: exhausted ? 'exhausted' : 'no_zone',
          floorHash,
          ceilingHash,
        });
        const saved = await persist(ctx, {
          ...audited,
          docketEntries: [
            ...audited.docketEntries,
            {
              at: now,
              stamp: exhausted ? 'SEALED SETTLEMENT EXHAUSTED' : 'NO ZONE OF AGREEMENT',
              note: exhausted ? 'Three confidential rounds completed without agreement. Enforcement track remains open.' : 'No confidential agreement in this round. Individual figures destroyed.',
            },
          ].slice(-60),
        });
        return {
          ok: true as const,
          ...settlementView(reset, access.role),
          logSummary: `${saved.docket}: confidential settlement ${exhausted ? 'exhausted' : 'did not overlap'}.`,
          logData: { docket: saved.docket, round: next.round },
        };
      }),
  });
}
