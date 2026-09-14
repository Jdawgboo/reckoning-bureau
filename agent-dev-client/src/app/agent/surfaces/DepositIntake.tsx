import { useCallback, useEffect, useMemo, useState, type FC, type FormEvent } from 'react';
import { Building2, CalendarDays, ClipboardCheck, FileText, Loader2, ReceiptText, WalletCards } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';
import { trpc } from '@/app/lib/trpc';

const messages = defineMessages({
  overline: { id: 'depositIntake.overline', defaultMessage: 'Deposit withheld — working record' },
  loading: { id: 'depositIntake.loading', defaultMessage: 'Opening the working record…' },
  unavailable: {
    id: 'depositIntake.unavailable',
    defaultMessage: 'The working record is unavailable. Nothing has been cleared. Reload this page before continuing.',
  },
  saved: { id: 'depositIntake.saved', defaultMessage: 'Recorded to the working record' },
  counterpartyTitle: { id: 'depositIntake.counterparty.title', defaultMessage: 'Who is holding the deposit?' },
  counterpartyHint: {
    id: 'depositIntake.counterparty.hint',
    defaultMessage: 'Use the landlord, letting agent, or management company name from the agreement or correspondence.',
  },
  counterpartyLabel: { id: 'depositIntake.counterparty.label', defaultMessage: 'Landlord, letting agent, or management company' },
  amountTitle: { id: 'depositIntake.amount.title', defaultMessage: 'What deposit is being withheld?' },
  amountHint: { id: 'depositIntake.amount.hint', defaultMessage: 'Record the amount paid and its currency.' },
  amountLabel: { id: 'depositIntake.amount.label', defaultMessage: 'Deposit amount' },
  currencyLabel: { id: 'depositIntake.amount.currency', defaultMessage: 'Currency' },
  moveOutTitle: { id: 'depositIntake.moveOut.title', defaultMessage: 'When did the tenancy end?' },
  moveOutHint: { id: 'depositIntake.moveOut.hint', defaultMessage: 'Give the key-handover or move-out date as precisely as you can.' },
  moveOutLabel: { id: 'depositIntake.moveOut.label', defaultMessage: 'Key handover or move-out date' },
  noticeTitle: { id: 'depositIntake.notice.title', defaultMessage: 'What did they say about keeping it?' },
  noticeHint: { id: 'depositIntake.notice.hint', defaultMessage: 'Quote the withholding notice and include its date if you know it.' },
  noticeLabel: { id: 'depositIntake.notice.label', defaultMessage: 'Withholding notice' },
  evidenceTitle: { id: 'depositIntake.evidence.title', defaultMessage: 'What evidence do you hold?' },
  evidenceHint: { id: 'depositIntake.evidence.hint', defaultMessage: 'List the documents or photographs you have. We will mark only those as held.' },
  evidenceLabel: { id: 'depositIntake.evidence.label', defaultMessage: 'Evidence held' },
  remedyTitle: { id: 'depositIntake.remedy.title', defaultMessage: 'What remedy do you require?' },
  remedyHint: { id: 'depositIntake.remedy.hint', defaultMessage: 'State the concrete amount or outcome you want recorded.' },
  remedyLabel: { id: 'depositIntake.remedy.label', defaultMessage: 'Remedy sought' },
  continue: { id: 'depositIntake.continue', defaultMessage: 'Record and continue' },
  review: { id: 'depositIntake.review', defaultMessage: 'Review the case file' },
  reviewTitle: { id: 'depositIntake.review.title', defaultMessage: 'Every particular is recorded' },
  reviewHint: {
    id: 'depositIntake.review.hint',
    defaultMessage: 'Open the read-back file. Nothing enters the public docket until you stamp it.',
  },
  required: { id: 'depositIntake.required', defaultMessage: 'Enter this detail before continuing.' },
  amountRequired: { id: 'depositIntake.amountRequired', defaultMessage: 'Enter a positive amount and a three-letter currency code.' },
});

type Step = 'counterparty' | 'amount' | 'moveOut' | 'notice' | 'evidence' | 'remedy' | 'review';

interface DepositDraft {
  counterpartyName: string | null;
  amountValue: number | null;
  currency: string | null;
  moveOutDate: string | null;
  withholdingNotice: string | null;
  evidenceSummary: string | null;
  remedySought: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readDraft(value: unknown): DepositDraft | null {
  if (!isRecord(value)) return null;
  const amount = value.amountValue;
  return {
    counterpartyName: readString(value, 'counterpartyName'),
    amountValue: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    currency: readString(value, 'currency'),
    moveOutDate: readString(value, 'moveOutDate'),
    withholdingNotice: readString(value, 'withholdingNotice'),
    evidenceSummary: readString(value, 'evidenceSummary'),
    remedySought: readString(value, 'remedySought'),
  };
}

function nextStep(draft: DepositDraft | null): Step {
  if (!draft?.counterpartyName) return 'counterparty';
  if (draft.amountValue === null || !draft.currency) return 'amount';
  if (!draft.moveOutDate) return 'moveOut';
  if (!draft.withholdingNotice) return 'notice';
  if (!draft.evidenceSummary) return 'evidence';
  if (!draft.remedySought) return 'remedy';
  return 'review';
}

function encodeDraft(draft: DepositDraft): string {
  return JSON.stringify({
    category: 'deposit-kept',
    counterpartyName: draft.counterpartyName,
    amountValue: draft.amountValue,
    currency: draft.currency,
    moveOutDate: draft.moveOutDate,
    withholdingNotice: draft.withholdingNotice,
    evidenceSummary: draft.evidenceSummary,
    remedySought: draft.remedySought,
  });
}

const STEP_ICONS = {
  counterparty: Building2,
  amount: WalletCards,
  moveOut: CalendarDays,
  notice: ReceiptText,
  evidence: FileText,
  remedy: ClipboardCheck,
  review: ClipboardCheck,
} as const;

export const DepositIntake: FC<A2uiNodeViewProps> = () => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const [draft, setDraft] = useState<DepositDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textValue, setTextValue] = useState('');
  const [amountValue, setAmountValue] = useState('');
  const [currency, setCurrency] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setUnavailable(false);
    try {
      const result = await trpc.intakeDrafts.getDeposit.query();
      const response = isRecord(result) ? readDraft(result.draft) : null;
      setDraft(response);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const step = useMemo(() => nextStep(draft), [draft]);

  useEffect(() => {
    setError(null);
    if (step === 'counterparty') setTextValue(draft?.counterpartyName ?? '');
    if (step === 'moveOut') setTextValue(draft?.moveOutDate ?? '');
    if (step === 'notice') setTextValue(draft?.withholdingNotice ?? '');
    if (step === 'evidence') setTextValue(draft?.evidenceSummary ?? '');
    if (step === 'remedy') setTextValue(draft?.remedySought ?? '');
    if (step === 'amount') {
      setAmountValue(draft?.amountValue?.toString() ?? '');
      setCurrency(draft?.currency ?? '');
    }
  }, [draft, step]);

  const save = useCallback(async (update: Record<string, string | number>) => {
    setSaving(true);
    setError(null);
    try {
      const result = await trpc.intakeDrafts.updateDeposit.mutate(update);
      const next = isRecord(result) ? readDraft(result.draft) : null;
      if (!next) throw new Error('missing draft');
      setDraft(next);
      return next;
    } catch {
      setUnavailable(true);
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step === 'review') {
      if (draft) dispatch?.('depositDraftReady', { draft: encodeDraft(draft) });
      return;
    }
    const trimmed = textValue.trim();
    if (step === 'amount') {
      const parsed = Number(amountValue.replace(/,/g, '').trim());
      const normalizedCurrency = currency.trim().toUpperCase();
      if (!Number.isFinite(parsed) || parsed <= 0 || !/^[A-Z]{3}$/.test(normalizedCurrency)) {
        setError(intl.formatMessage(messages.amountRequired));
        return;
      }
      await save({ amountValue: parsed, currency: normalizedCurrency });
      return;
    }
    if (!trimmed) {
      setError(intl.formatMessage(messages.required));
      return;
    }
    const key = step === 'counterparty'
      ? 'counterpartyName'
      : step === 'moveOut'
        ? 'moveOutDate'
        : step === 'notice'
          ? 'withholdingNotice'
          : step === 'evidence'
            ? 'evidenceSummary'
            : 'remedySought';
    await save({ [key]: trimmed });
  };

  const content = (() => {
    switch (step) {
      case 'counterparty':
        return { title: messages.counterpartyTitle, hint: messages.counterpartyHint, label: messages.counterpartyLabel, multiline: false };
      case 'amount':
        return { title: messages.amountTitle, hint: messages.amountHint, label: messages.amountLabel, multiline: false };
      case 'moveOut':
        return { title: messages.moveOutTitle, hint: messages.moveOutHint, label: messages.moveOutLabel, multiline: false };
      case 'notice':
        return { title: messages.noticeTitle, hint: messages.noticeHint, label: messages.noticeLabel, multiline: true };
      case 'evidence':
        return { title: messages.evidenceTitle, hint: messages.evidenceHint, label: messages.evidenceLabel, multiline: true };
      case 'remedy':
        return { title: messages.remedyTitle, hint: messages.remedyHint, label: messages.remedyLabel, multiline: true };
      case 'review':
        return { title: messages.reviewTitle, hint: messages.reviewHint, label: messages.review, multiline: false };
    }
  })();
  const Icon = STEP_ICONS[step];

  if (loading) {
    return <p className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">{intl.formatMessage(messages.loading)}</p>;
  }

  if (unavailable) {
    return <p className="border-l-2 border-primary px-3 text-body-sm text-foreground">{intl.formatMessage(messages.unavailable)}</p>;
  }

  return (
    <section className="w-full border border-border bg-card p-6 shadow-elevated sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div>
          <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {intl.formatMessage(messages.overline)}
          </div>
          <h1 className="mt-2 max-w-[24ch] text-balance font-display text-heading-xl font-semibold tracking-tight text-foreground">
            {intl.formatMessage(content.title)}
          </h1>
        </div>
        <span className="flex h-10 w-10 items-center justify-center border border-primary/40 bg-muted text-primary" aria-hidden="true">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>
      <p className="mt-5 max-w-[66ch] text-body-sm leading-relaxed text-muted-foreground">{intl.formatMessage(content.hint)}</p>
      <div className="mt-5 border-l-2 border-primary/60 px-3 font-mono text-body-xs uppercase tracking-caps text-primary">
        {intl.formatMessage(messages.saved)}
      </div>
      <form className="mt-6" onSubmit={submit}>
        {step === 'amount' ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <label className="block min-w-0 font-mono text-body-xs uppercase tracking-caps text-foreground">
              {intl.formatMessage(content.label)}
              <input
                value={amountValue}
                onChange={(event) => setAmountValue(event.target.value)}
                inputMode="decimal"
                className="mt-2 block w-full border border-border bg-background px-3 py-3 text-body-base tabular-nums text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              />
            </label>
            <label className="block min-w-0 font-mono text-body-xs uppercase tracking-caps text-foreground">
              {intl.formatMessage(messages.currencyLabel)}
              <input
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                maxLength={3}
                className="mt-2 block w-full border border-border bg-background px-3 py-3 text-body-base uppercase text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              />
            </label>
          </div>
        ) : step === 'review' ? null : (
          <label className="block font-mono text-body-xs uppercase tracking-caps text-foreground">
            {intl.formatMessage(content.label)}
            {content.multiline ? (
              <textarea
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                rows={5}
                className="mt-2 block w-full resize-y border border-border bg-background px-3 py-3 text-body-sm leading-relaxed text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              />
            ) : (
              <input
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                className="mt-2 block w-full border border-border bg-background px-3 py-3 text-body-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              />
            )}
          </label>
        )}
        {error ? <p className="mt-3 text-body-sm text-foreground" role="alert">{error}</p> : null}
        <button
          type="submit"
          disabled={saving}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 border-2 border-primary bg-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary-foreground transition duration-150 hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" /> : null}
          {intl.formatMessage(step === 'review' ? messages.review : messages.continue)}
        </button>
      </form>
    </section>
  );
};
