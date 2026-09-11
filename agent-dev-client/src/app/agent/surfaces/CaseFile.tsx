import { useCallback, useMemo, useState, type FC, type ReactNode } from 'react';
import { Check, Loader2, Square, Stamp } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, num, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';
import { useLiveQuery } from '@/app/lib/hooks/useLiveQuery.ts';
import { trpc } from '@/app/lib/trpc';

/**
 * The case file. Unfiled it is a draft the visitor stamps; the stamp calls
 * `cases.open`, the registry mints the docket number, and from that moment the
 * stored copy — fetched live and refreshed on every registry mutation — is what
 * the screen shows. The docket number is never composed on the client.
 */

const messages = defineMessages({
  caseFile: { id: 'caseFile.label', defaultMessage: 'Case file' },
  unfiled: { id: 'caseFile.unfiled', defaultMessage: 'Unfiled' },
  opened: { id: 'caseFile.opened', defaultMessage: 'Opened {date}' },
  claim: { id: 'caseFile.claim', defaultMessage: 'Amount in dispute' },
  claimant: { id: 'caseFile.claimant', defaultMessage: 'Claimant' },
  correspondence: { id: 'caseFile.correspondence', defaultMessage: 'Correspondence' },
  lane: { id: 'caseFile.lane', defaultMessage: 'Matter' },
  particulars: { id: 'caseFile.particulars', defaultMessage: 'Particulars' },
  chronology: { id: 'caseFile.chronology', defaultMessage: 'Chronology' },
  evidence: { id: 'caseFile.evidence', defaultMessage: 'Schedule of evidence' },
  evidenceMissing: { id: 'caseFile.evidenceMissing', defaultMessage: 'to obtain' },
  remedy: { id: 'caseFile.remedy', defaultMessage: 'Remedy sought' },
  ledger: { id: 'caseFile.ledger', defaultMessage: 'Docket' },
  nextAction: { id: 'caseFile.nextAction', defaultMessage: 'Next action' },
  due: { id: 'caseFile.due', defaultMessage: 'due {date}' },
  stampAction: { id: 'caseFile.stampAction', defaultMessage: 'Stamp and open the file' },
  filing: { id: 'caseFile.filing', defaultMessage: 'Entering in the register…' },
  filingNote: {
    id: 'caseFile.filingNote',
    defaultMessage:
      'Opening the file enters it in our register under a docket number and starts the record. Nothing is sent to the other side until you say so.',
  },
  filingFailed: {
    id: 'caseFile.filingFailed',
    defaultMessage: 'The register refused the entry. Nothing was filed — press the stamp again.',
  },
  loading: { id: 'caseFile.loading', defaultMessage: 'Retrieving the file…' },
  missing: {
    id: 'caseFile.missing',
    defaultMessage: 'No file under that docket number in our register.',
  },
  statusReceived: { id: 'caseFile.status.received', defaultMessage: 'Received' },
  statusDemand: { id: 'caseFile.status.demandIssued', defaultMessage: 'Demand issued' },
  statusEscalated: { id: 'caseFile.status.escalated', defaultMessage: 'Escalated' },
  statusResolved: { id: 'caseFile.status.resolved', defaultMessage: 'Resolved' },
  statusWithdrawn: { id: 'caseFile.status.withdrawn', defaultMessage: 'Withdrawn' },
  laneRefund: { id: 'caseFile.lane.refundRefused', defaultMessage: 'Refund refused' },
  laneDeposit: { id: 'caseFile.lane.depositKept', defaultMessage: 'Deposit withheld' },
  laneDelivery: { id: 'caseFile.lane.neverDelivered', defaultMessage: 'Paid, never delivered' },
  laneOther: { id: 'caseFile.lane.somethingElse', defaultMessage: 'Other grievance' },
});

const STATUS_MESSAGES = {
  received: messages.statusReceived,
  demand_issued: messages.statusDemand,
  escalated: messages.statusEscalated,
  resolved: messages.statusResolved,
  withdrawn: messages.statusWithdrawn,
} as const;

const LANE_MESSAGES = {
  'refund-refused': messages.laneRefund,
  'deposit-kept': messages.laneDeposit,
  'never-delivered': messages.laneDelivery,
  'something-else': messages.laneOther,
} as const;

interface TimelineRow {
  date?: string;
  event: string;
}

interface EvidenceRow {
  label: string;
  held: boolean;
  detail?: string;
}

interface DocketRow {
  at: string;
  stamp: string;
  note: string;
}

interface CaseView {
  docket?: string;
  status?: keyof typeof STATUS_MESSAGES;
  openedAt?: string;
  counterpartyName: string;
  counterpartyKind?: string;
  category: string;
  summary: string;
  remedySought: string;
  amountValue?: number;
  currency?: string;
  claimantName?: string;
  claimantContact?: string;
  chronology: TimelineRow[];
  evidence: EvidenceRow[];
  docketEntries: DocketRow[];
  nextActionLabel?: string;
  nextActionDueAt?: string;
}

function readTimeline(value: unknown): TimelineRow[] {
  return arr(value)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { date: optStr(row.date), event: str(row.event) };
    })
    .filter((row) => row.event.length > 0);
}

function readEvidence(value: unknown): EvidenceRow[] {
  return arr(value)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { label: str(row.label), held: row.held === true, detail: optStr(row.detail) };
    })
    .filter((row) => row.label.length > 0);
}

function readDocketEntries(value: unknown): DocketRow[] {
  return arr(value)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { at: str(row.at), stamp: str(row.stamp), note: str(row.note) };
    })
    .filter((row) => row.stamp.length > 0);
}

function viewFromProps(props: Record<string, unknown>): CaseView {
  return {
    counterpartyName: str(props.counterpartyName),
    counterpartyKind: optStr(props.counterpartyKind),
    category: str(props.category),
    summary: str(props.summary),
    remedySought: str(props.remedySought),
    amountValue: num(props.amountValue),
    currency: optStr(props.currency),
    claimantName: optStr(props.claimantName),
    claimantContact: optStr(props.claimantContact),
    chronology: readTimeline(props.chronology),
    evidence: readEvidence(props.evidence),
    docketEntries: [],
  };
}

function viewFromRecord(record: Record<string, unknown>): CaseView {
  const status = str(record.status);
  return {
    docket: optStr(record.docket),
    status: status in STATUS_MESSAGES ? (status as keyof typeof STATUS_MESSAGES) : 'received',
    openedAt: optStr(record.openedAt),
    counterpartyName: str(record.counterpartyName),
    counterpartyKind: optStr(record.counterpartyKind),
    category: str(record.category),
    summary: str(record.summary),
    remedySought: str(record.remedySought),
    amountValue: num(record.amountValue),
    currency: optStr(record.currency),
    claimantName: optStr(record.claimantName),
    claimantContact: optStr(record.claimantContact),
    chronology: readTimeline(record.chronology),
    evidence: readEvidence(record.evidence),
    docketEntries: readDocketEntries(record.docketEntries),
    nextActionLabel: optStr(record.nextActionLabel),
    nextActionDueAt: optStr(record.nextActionDueAt),
  };
}

const Label: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
    {children}
  </div>
);

const CaseBody: FC<{ view: CaseView }> = ({ view }) => {
  const intl = useIntl();
  const laneMessage = LANE_MESSAGES[view.category as keyof typeof LANE_MESSAGES];
  const amount =
    view.amountValue !== undefined && view.currency
      ? intl.formatNumber(view.amountValue, {
          style: 'currency',
          currency: view.currency,
          maximumFractionDigits: 2,
        })
      : view.amountValue !== undefined
        ? intl.formatNumber(view.amountValue)
        : null;

  return (
    <>
      <dl className="mt-6 grid gap-x-8 gap-y-4 border-y border-border py-4 sm:grid-cols-3">
        <div>
          <Label>{intl.formatMessage(messages.lane)}</Label>
          <dd className="mt-1 text-body-sm text-foreground">
            {laneMessage ? intl.formatMessage(laneMessage) : view.category}
          </dd>
        </div>
        {amount ? (
          <div>
            <Label>{intl.formatMessage(messages.claim)}</Label>
            <dd className="mt-1 font-mono text-body-base font-medium tabular-nums text-foreground">
              {amount}
            </dd>
          </div>
        ) : null}
        {view.claimantName ? (
          <div>
            <Label>{intl.formatMessage(messages.claimant)}</Label>
            <dd className="mt-1 text-body-sm text-foreground">{view.claimantName}</dd>
          </div>
        ) : null}
        {view.claimantContact ? (
          <div className="min-w-0">
            <Label>{intl.formatMessage(messages.correspondence)}</Label>
            <dd className="mt-1 truncate text-body-sm text-foreground">{view.claimantContact}</dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-6">
        <Label>{intl.formatMessage(messages.particulars)}</Label>
        <p className="mt-2 max-w-[70ch] whitespace-pre-line font-display text-body-base leading-relaxed text-foreground">
          {view.summary}
        </p>
      </div>

      {view.chronology.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.chronology)}</Label>
          <ol className="mt-2 space-y-2">
            {view.chronology.map((row, index) => (
              <li key={`${row.date ?? ''}-${row.event}-${index}`} className="flex gap-3">
                <span className="w-28 shrink-0 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
                  {row.date ?? '—'}
                </span>
                <span className="min-w-0 text-body-sm text-foreground">{row.event}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {view.evidence.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.evidence)}</Label>
          <ul className="mt-2 space-y-2">
            {view.evidence.map((row) => (
              <li key={row.label} className="flex gap-3">
                {row.held ? (
                  <Check
                    className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                    strokeWidth={2.25}
                    aria-hidden="true"
                  />
                ) : (
                  <Square
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground-subtle"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span
                    className={
                      row.held ? 'text-body-sm text-foreground' : 'text-body-sm text-muted-foreground'
                    }
                  >
                    {row.label}
                  </span>
                  {row.held ? null : (
                    <span className="ml-2 font-mono text-body-xs uppercase tracking-caps text-primary">
                      {intl.formatMessage(messages.evidenceMissing)}
                    </span>
                  )}
                  {row.detail ? (
                    <span className="block text-body-xs text-muted-foreground-subtle">
                      {row.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 border-l-2 border-primary pl-3">
        <Label>{intl.formatMessage(messages.remedy)}</Label>
        <p className="mt-1 font-display text-heading-sm font-semibold text-foreground">
          {view.remedySought}
        </p>
      </div>

      {view.docketEntries.length > 0 ? (
        <div className="mt-8 border-t border-border pt-5">
          <Label>{intl.formatMessage(messages.ledger)}</Label>
          <ol className="mt-3 space-y-2">
            {view.docketEntries
              .slice()
              .reverse()
              .map((row, index) => (
                <li key={`${row.at}-${index}`} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground-subtle">
                    {row.at
                      ? intl.formatDate(row.at, {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </span>
                  <span className="border border-primary/50 px-1.5 font-mono text-body-xs uppercase tracking-caps text-primary">
                    {row.stamp}
                  </span>
                  <span className="min-w-0 text-body-sm text-foreground">{row.note}</span>
                </li>
              ))}
          </ol>
        </div>
      ) : null}

      {view.nextActionLabel ? (
        <div className="mt-6 bg-muted p-4">
          <Label>{intl.formatMessage(messages.nextAction)}</Label>
          <p className="mt-1 text-body-sm text-foreground">
            {view.nextActionLabel}
            {view.nextActionDueAt ? (
              <span className="ml-2 font-mono text-body-xs uppercase tracking-caps text-primary">
                {intl.formatMessage(messages.due, {
                  date: intl.formatDate(view.nextActionDueAt, {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  }),
                })}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}
    </>
  );
};

export const CaseFile: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const propDocket = optStr(node.props.docket);
  const [filedDocket, setFiledDocket] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [failed, setFailed] = useState(false);
  const docket = filedDocket ?? propDocket ?? null;
  const draft = useMemo(() => viewFromProps(node.props), [node.props]);

  const stored = useLiveQuery(
    'cases',
    async () => (docket ? await trpc.cases.get.query({ docket }) : null),
    [docket],
  );

  const file = useCallback(async () => {
    setFiling(true);
    setFailed(false);
    try {
      const result = await trpc.cases.open.mutate({
        counterpartyName: draft.counterpartyName,
        counterpartyKind: draft.counterpartyKind ?? null,
        category: draft.category,
        summary: draft.summary,
        remedySought: draft.remedySought,
        amountValue: draft.amountValue ?? null,
        currency: draft.currency ?? null,
        claimantName: draft.claimantName ?? null,
        claimantContact: draft.claimantContact ?? null,
        chronology: draft.chronology.map((row) => ({ date: row.date ?? null, event: row.event })),
        evidence: draft.evidence.map((row) => ({
          label: row.label,
          held: row.held,
          detail: row.detail ?? null,
        })),
      });
      const opened = (result as { case?: { docket?: unknown } } | null)?.case;
      const newDocket = typeof opened?.docket === 'string' ? opened.docket : null;
      if (!newDocket) {
        setFailed(true);
        return;
      }
      setFiledDocket(newDocket);
      dispatch?.('caseFiled', {
        docket: newDocket,
        counterpartyName: draft.counterpartyName,
      });
    } catch (error) {
      console.error('[CaseFile] filing failed:', error);
      setFailed(true);
    } finally {
      setFiling(false);
    }
  }, [dispatch, draft]);

  const record = stored.data as Record<string, unknown> | null | undefined;
  const view = docket && record ? viewFromRecord(record) : draft;
  const statusMessage = view.status ? STATUS_MESSAGES[view.status] : null;

  return (
    <section className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Label>{intl.formatMessage(messages.caseFile)}</Label>
          <div className="mt-1 font-mono text-heading-md font-medium tracking-tight text-foreground">
            {docket ?? '—'}
          </div>
          {view.openedAt ? (
            <div className="mt-1 font-mono text-body-xs uppercase tracking-caps text-muted-foreground-subtle">
              {intl.formatMessage(messages.opened, {
                date: intl.formatDate(view.openedAt, {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                }),
              })}
            </div>
          ) : null}
        </div>
        {docket && statusMessage ? (
          <span className="-rotate-2 border-2 border-primary px-3 py-1 font-mono text-body-sm uppercase tracking-caps text-primary">
            {intl.formatMessage(statusMessage)}
          </span>
        ) : (
          <span className="-rotate-2 border-2 border-dashed border-muted-foreground-subtle px-3 py-1 font-mono text-body-sm uppercase tracking-caps text-muted-foreground-subtle">
            {intl.formatMessage(messages.unfiled)}
          </span>
        )}
      </div>

      <h1 className="mt-5 text-balance font-display text-heading-xl font-semibold tracking-tight text-foreground">
        {view.counterpartyName}
        {view.counterpartyKind ? (
          <span className="ml-3 align-middle font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {view.counterpartyKind}
          </span>
        ) : null}
      </h1>

      {docket && stored.isLoading && !record ? (
        <p className="mt-6 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
          {intl.formatMessage(messages.loading)}
        </p>
      ) : docket && !record && !stored.isLoading ? (
        <p className="mt-6 text-body-sm text-muted-foreground">
          {intl.formatMessage(messages.missing)}
        </p>
      ) : (
        <CaseBody view={view} />
      )}

      {docket ? null : (
        <div className="mt-8 border-t border-border pt-6">
          <button
            type="button"
            onClick={file}
            disabled={filing}
            className="flex w-full items-center justify-center gap-2 border-2 border-primary px-5 py-3 font-mono text-body-sm uppercase tracking-caps text-primary transition duration-150 hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {filing ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Stamp className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            )}
            {intl.formatMessage(filing ? messages.filing : messages.stampAction)}
          </button>
          {failed ? (
            <p className="mt-3 font-mono text-body-xs text-primary">
              {intl.formatMessage(messages.filingFailed)}
            </p>
          ) : (
            <p className="mt-3 max-w-[62ch] font-mono text-body-xs leading-relaxed text-muted-foreground-subtle">
              {intl.formatMessage(messages.filingNote)}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
