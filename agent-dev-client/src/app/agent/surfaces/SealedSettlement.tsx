import { useCallback, useMemo, useState, type FC } from 'react';
import { Check, ClipboardCopy, LockKeyhole, Loader2, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import { useLiveQuery } from '@/app/lib/hooks/useLiveQuery.ts';
import { trpc } from '@/app/lib/trpc';

const messages = defineMessages({
  heading: { id: 'sealedSettlement.heading', defaultMessage: 'Sealed settlement' },
  claimantIntro: {
    id: 'sealedSettlement.claimantIntro',
    defaultMessage:
      'Invite the other side to a confidential, double-blind settlement round. Neither figure is shown to the other party.',
  },
  start: { id: 'sealedSettlement.start', defaultMessage: 'Open a sealed settlement round' },
  starting: { id: 'sealedSettlement.starting', defaultMessage: 'Opening private invitations…' },
  startFailed: {
    id: 'sealedSettlement.startFailed',
    defaultMessage: 'The private invitations could not be created. Nothing was opened.',
  },
  claimantCode: { id: 'sealedSettlement.claimantCode', defaultMessage: 'Your private access code' },
  respondentCode: { id: 'sealedSettlement.respondentCode', defaultMessage: 'Code to share with the respondent' },
  copy: { id: 'sealedSettlement.copy', defaultMessage: 'Copy' },
  copied: { id: 'sealedSettlement.copied', defaultMessage: 'Copied' },
  codeHelp: {
    id: 'sealedSettlement.codeHelp',
    defaultMessage: 'Keep your code private. Share only the respondent code with the other side.',
  },
  portalHeading: { id: 'sealedSettlement.portalHeading', defaultMessage: 'Enter a sealed settlement invitation' },
  portalHelp: {
    id: 'sealedSettlement.portalHelp',
    defaultMessage: 'This opens only the confidential settlement desk. It does not reveal the other party’s case file.',
  },
  codeLabel: { id: 'sealedSettlement.codeLabel', defaultMessage: 'Invitation code' },
  codePlaceholder: { id: 'sealedSettlement.codePlaceholder', defaultMessage: 'RB-S-…' },
  open: { id: 'sealedSettlement.open', defaultMessage: 'Open the sealed desk' },
  opening: { id: 'sealedSettlement.opening', defaultMessage: 'Checking invitation…' },
  invalid: { id: 'sealedSettlement.invalid', defaultMessage: 'That invitation is not recognised.' },
  round: { id: 'sealedSettlement.round', defaultMessage: 'Round {round} of 3' },
  privateFigure: { id: 'sealedSettlement.privateFigure', defaultMessage: 'Your private figure' },
  claimantFigure: { id: 'sealedSettlement.claimantFigure', defaultMessage: 'Minimum you would accept' },
  respondentFigure: { id: 'sealedSettlement.respondentFigure', defaultMessage: 'Maximum you would pay' },
  figureHelp: {
    id: 'sealedSettlement.figureHelp',
    defaultMessage: 'This figure goes only to the Registrar. It is never shown to the other party.',
  },
  submit: { id: 'sealedSettlement.submit', defaultMessage: 'Submit sealed figure' },
  submitting: { id: 'sealedSettlement.submitting', defaultMessage: 'Sealing figure…' },
  invalidAmount: { id: 'sealedSettlement.invalidAmount', defaultMessage: 'Enter a non-negative amount before sealing it.' },
  sealed: { id: 'sealedSettlement.sealed', defaultMessage: 'Sealed. Awaiting the other party.' },
  sealedHelp: {
    id: 'sealedSettlement.sealedHelp',
    defaultMessage: 'No range, direction, or closeness is disclosed while the round is open.',
  },
  noZone: { id: 'sealedSettlement.noZone', defaultMessage: 'No zone of agreement in this round.' },
  noZoneHelp: {
    id: 'sealedSettlement.noZoneHelp',
    defaultMessage: 'The figures were destroyed. You may enter a new figure for the next round; no hint is provided.',
  },
  settled: { id: 'sealedSettlement.settled', defaultMessage: 'Settled by agreement' },
  settlementNotice: {
    id: 'sealedSettlement.settlementNotice',
    defaultMessage: 'The Registrar found a zone of agreement and fixed the midpoint below. Neither sealed figure is disclosed.',
  },
  exhausted: { id: 'sealedSettlement.exhausted', defaultMessage: 'Sealed settlement exhausted' },
  exhaustedHelp: {
    id: 'sealedSettlement.exhaustedHelp',
    defaultMessage: 'Three rounds completed without agreement. The ordinary enforcement track remains open.',
  },
  unavailable: { id: 'sealedSettlement.unavailable', defaultMessage: 'Private settlement is unavailable for this docket.' },
  reopened: { id: 'sealedSettlement.reopened', defaultMessage: 'The private desk is already open. Use your private access code to re-enter.' },
});

type Role = 'claimant' | 'respondent';
type SettlementState = 'ready' | 'sealed' | 'no_zone' | 'settled' | 'exhausted';

interface SettlementStatus {
  docket: string;
  role: Role;
  state: SettlementState;
  round: number;
  roundsRun: number;
  currency: string;
  settledAmount: number | null;
}

const CodeRow: FC<{ label: string; code: string }> = ({ label, code }) => {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch (error) {
      console.error('[SealedSettlement] copy failed:', error);
    }
  }, [code]);

  return (
    <div className="border border-border bg-card p-3">
      <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">{label}</div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all font-mono text-body-xs text-foreground" translate="no">
          {code}
        </code>
        <button
          type="button"
          onClick={copy}
          className="flex shrink-0 items-center gap-1.5 border border-border px-2.5 py-1.5 font-mono text-body-xs uppercase tracking-caps text-foreground transition hover:border-primary/50 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98]"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> : <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />}
          {intl.formatMessage(copied ? messages.copied : messages.copy)}
        </button>
      </div>
    </div>
  );
};

export const SealedBidPanel: FC<{ accessCode: string; role: Role }> = ({ accessCode, role }) => {
  const intl = useIntl();
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusQuery = useLiveQuery(
    'cases',
    async () => await trpc.cases.settlementStatus.query({ accessCode }),
    [accessCode],
  );
  const status = statusQuery.data as SettlementStatus | null | undefined;
  const readyForFigure = status?.state === 'ready' || status?.state === 'no_zone';
  const currency = status?.currency || 'USD';
  const figureLabel = role === 'claimant' ? messages.claimantFigure : messages.respondentFigure;

  const submit = useCallback(async () => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0 || amount.trim() === '') {
      setError(intl.formatMessage(messages.invalidAmount));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await trpc.cases.submitSealedFigure.mutate({ accessCode, amount: parsed });
      if ((result as { ok?: boolean } | null)?.ok !== true) {
        setError(intl.formatMessage(messages.unavailable));
        return;
      }
      setAmount('');
    } catch (requestError) {
      console.error('[SealedSettlement] submit failed:', requestError);
      setError(intl.formatMessage(messages.unavailable));
    } finally {
      setSubmitting(false);
    }
  }, [accessCode, amount, intl]);

  const formattedSettlement = useMemo(() => {
    if (status?.state !== 'settled' || status.settledAmount === null) {
      return null;
    }
    return intl.formatNumber(status.settledAmount, { style: 'currency', currency, maximumFractionDigits: 2 });
  }, [currency, intl, status?.settledAmount, status?.state]);

  if (statusQuery.isLoading && !status) {
    return (
      <p className="mt-4 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
        {intl.formatMessage(messages.opening)}
      </p>
    );
  }

  if (!status) {
    return <p className="mt-4 text-body-sm text-muted-foreground">{intl.formatMessage(messages.invalid)}</p>;
  }

  return (
    <div className="mt-4 border-2 border-primary/60 bg-muted p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-body-xs uppercase tracking-caps text-primary">
            <LockKeyhole className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {intl.formatMessage(messages.heading)}
          </div>
          <p className="mt-1 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {intl.formatMessage(messages.round, { round: status.round })}
          </p>
        </div>
        <span className="border border-primary px-2.5 py-1 font-mono text-body-xs uppercase tracking-caps text-primary">
          {role}
        </span>
      </div>

      {readyForFigure ? (
        <div className="mt-5">
          {status.state === 'no_zone' ? (
            <p className="mb-4 text-body-sm text-foreground">
              {intl.formatMessage(messages.noZone)}
              <span className="mt-1 block text-muted-foreground">{intl.formatMessage(messages.noZoneHelp)}</span>
            </p>
          ) : null}
          <label className="block">
            <span className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
              {intl.formatMessage(figureLabel)} · {currency}
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="mt-2 w-full border border-border bg-card px-3 py-2.5 font-mono text-body-base tabular-nums text-foreground outline-none transition placeholder:text-muted-foreground-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
            />
          </label>
          <p className="mt-2 text-body-xs leading-relaxed text-muted-foreground">{intl.formatMessage(messages.figureHelp)}</p>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="mt-4 flex w-full items-center justify-center gap-2 border-2 border-primary bg-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary-foreground transition hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LockKeyhole className="h-4 w-4" aria-hidden="true" />}
            {intl.formatMessage(submitting ? messages.submitting : messages.submit)}
          </button>
          {error ? <p className="mt-3 text-body-xs text-primary">{error}</p> : null}
        </div>
      ) : null}

      {status.state === 'sealed' ? (
        <div className="mt-5 border-l-2 border-primary pl-3">
          <p className="font-display text-heading-sm font-semibold text-foreground">{intl.formatMessage(messages.sealed)}</p>
          <p className="mt-1 text-body-sm text-muted-foreground">{intl.formatMessage(messages.sealedHelp)}</p>
        </div>
      ) : null}

      {status.state === 'settled' && formattedSettlement ? (
        <div className="mt-5 border-l-2 border-primary pl-3">
          <div className="flex items-center gap-2 text-primary">
            <ShieldCheck className="h-5 w-5" strokeWidth={1.9} aria-hidden="true" />
            <p className="font-mono text-body-xs uppercase tracking-caps">{intl.formatMessage(messages.settled)}</p>
          </div>
          <p className="mt-2 font-display text-heading-xl font-semibold tabular-nums text-foreground">{formattedSettlement}</p>
          <p className="mt-2 max-w-[60ch] text-body-sm text-muted-foreground">{intl.formatMessage(messages.settlementNotice)}</p>
        </div>
      ) : null}

      {status.state === 'exhausted' ? (
        <div className="mt-5 border-l-2 border-primary pl-3">
          <p className="font-display text-heading-sm font-semibold text-foreground">{intl.formatMessage(messages.exhausted)}</p>
          <p className="mt-1 text-body-sm text-muted-foreground">{intl.formatMessage(messages.exhaustedHelp)}</p>
        </div>
      ) : null}
    </div>
  );
};

export const ClaimantSettlementPanel: FC<{ docket: string }> = ({ docket }) => {
  const intl = useIntl();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [codes, setCodes] = useState<{ claimantCode: string; respondentCode: string } | null>(null);

  const start = useCallback(async () => {
    setOpening(true);
    setFailed(false);
    try {
      const result = await trpc.cases.startSettlement.mutate({ docket });
      const data = result as { ok?: boolean; claimantCode?: string; respondentCode?: string; reason?: string } | null;
      if (data?.ok === true && data.claimantCode && data.respondentCode) {
        setCodes({ claimantCode: data.claimantCode, respondentCode: data.respondentCode });
      } else {
        setFailed(true);
      }
    } catch (error) {
      console.error('[SealedSettlement] start failed:', error);
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }, [docket]);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-primary" strokeWidth={1.75} aria-hidden="true" />
        <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
          {intl.formatMessage(messages.heading)}
        </div>
      </div>
      <p className="mt-2 max-w-[68ch] text-body-sm text-foreground">{intl.formatMessage(messages.claimantIntro)}</p>

      {codes ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <CodeRow label={intl.formatMessage(messages.claimantCode)} code={codes.claimantCode} />
            <CodeRow label={intl.formatMessage(messages.respondentCode)} code={codes.respondentCode} />
          </div>
          <p className="mt-3 text-body-xs leading-relaxed text-muted-foreground">{intl.formatMessage(messages.codeHelp)}</p>
          <SealedBidPanel accessCode={codes.claimantCode} role="claimant" />
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={start}
            disabled={opening}
            className="mt-4 flex w-full items-center justify-center gap-2 border-2 border-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary transition hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {opening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LockKeyhole className="h-4 w-4" aria-hidden="true" />}
            {intl.formatMessage(opening ? messages.starting : messages.start)}
          </button>
          {failed ? <p className="mt-3 text-body-xs text-primary">{intl.formatMessage(messages.startFailed)}</p> : null}
        </>
      )}
    </section>
  );
};

export const SettlementPortal: FC = () => {
  const intl = useIntl();
  const [code, setCode] = useState('');
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const [entry, setEntry] = useState<{ docket: string; role: Role; accessCode: string } | null>(null);

  const open = useCallback(async () => {
    setOpening(true);
    setFailed(false);
    try {
      const result = await trpc.cases.redeemSettlementInvite.mutate({ code: code.trim() });
      const data = result as { ok?: boolean; docket?: string; role?: Role } | null;
      if (data?.ok === true && data.docket && (data.role === 'claimant' || data.role === 'respondent')) {
        setEntry({ docket: data.docket, role: data.role, accessCode: code.trim() });
      } else {
        setFailed(true);
      }
    } catch (error) {
      console.error('[SealedSettlement] invitation redemption failed:', error);
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }, [code]);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-primary" strokeWidth={1.75} aria-hidden="true" />
        <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
          {intl.formatMessage(messages.portalHeading)}
        </div>
      </div>
      <p className="mt-2 max-w-[68ch] text-body-sm text-muted-foreground">{intl.formatMessage(messages.portalHelp)}</p>

      {entry ? (
        <SealedBidPanel accessCode={entry.accessCode} role={entry.role} />
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="sr-only">{intl.formatMessage(messages.codeLabel)}</span>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={intl.formatMessage(messages.codePlaceholder)}
              className="w-full border border-border bg-card px-3 py-2.5 font-mono text-body-sm text-foreground outline-none transition placeholder:text-muted-foreground-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
            />
          </label>
          <button
            type="button"
            onClick={open}
            disabled={opening || code.trim().length < 20}
            className="flex shrink-0 items-center justify-center gap-2 border-2 border-primary px-4 py-2.5 font-mono text-body-xs uppercase tracking-caps text-primary transition hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {opening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LockKeyhole className="h-4 w-4" aria-hidden="true" />}
            {intl.formatMessage(opening ? messages.opening : messages.open)}
          </button>
        </div>
      )}
      {failed ? <p className="mt-3 text-body-xs text-primary">{intl.formatMessage(messages.invalid)}</p> : null}
    </section>
  );
};
