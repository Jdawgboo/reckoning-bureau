import { useCallback, useEffect, useState, type FC } from 'react';
import { BadgeCheck, ExternalLink, Loader2, LockKeyhole } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { num, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';
import { trpc } from '@/app/lib/trpc';

const messages = defineMessages({
  label: { id: 'paymentGate.label', defaultMessage: 'Filing fee' },
  heading: { id: 'paymentGate.heading', defaultMessage: 'Issue the paperwork' },
  preparedFor: { id: 'paymentGate.preparedFor', defaultMessage: 'Prepared for docket {docket}' },
  oneTime: { id: 'paymentGate.oneTime', defaultMessage: 'One-time document preparation' },
  safety: {
    id: 'paymentGate.safety',
    defaultMessage: 'Card details are entered only on Stripe’s secure hosted checkout. The Bureau does not see or store them.',
  },
  begin: { id: 'paymentGate.begin', defaultMessage: 'Continue to secure checkout' },
  ready: { id: 'paymentGate.ready', defaultMessage: 'Open secure checkout' },
  returnNote: {
    id: 'paymentGate.returnNote',
    defaultMessage: 'After checkout, return here. We verify payment before preparing the issued document.',
  },
  checking: { id: 'paymentGate.checking', defaultMessage: 'Verifying payment…' },
  verified: { id: 'paymentGate.verified', defaultMessage: 'Filing fee verified' },
  continue: { id: 'paymentGate.continue', defaultMessage: 'Prepare the demand letter' },
  unavailable: {
    id: 'paymentGate.unavailable',
    defaultMessage: 'Secure checkout is unavailable at present. No payment was taken.',
  },
});

type PaymentStatus = 'loading' | 'none' | 'pending' | 'paid' | 'unavailable';

export const PaymentGate: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const docket = str(node.props.docket);
  const itemName = str(node.props.itemName);
  const currency = str(node.props.currency).toUpperCase() || 'USD';
  const amountCents = num(node.props.amountCents) ?? 0;
  const [status, setStatus] = useState<PaymentStatus>('loading');
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const sessionId = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('session_id');
  const returnedFromCheckout = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('checkout') === 'success';
  const amount = intl.formatNumber(amountCents / 100, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });

  useEffect(() => {
    if (!docket) return;
    if (returnedFromCheckout && sessionId?.startsWith('cs_')) {
      setStatus('loading');
      void trpc.payments.verifyCheckout
        .mutate({ docket, sessionId })
        .then((result) => {
          const next = result as { ok?: boolean; status?: 'pending' | 'paid' } | null;
          setStatus(next?.ok && next.status ? next.status : 'unavailable');
        })
        .catch(() => setStatus('unavailable'));
      return;
    }
    void trpc.payments.getStatus
      .query({ docket })
      .then((result) => setStatus((result as { status?: PaymentStatus } | null)?.status ?? 'none'))
      .catch(() => setStatus('unavailable'));
  }, [docket, returnedFromCheckout, sessionId]);

  const createCheckout = useCallback(async () => {
    if (!docket || typeof window === 'undefined') return;
    setStatus('loading');
    try {
      const result = await trpc.payments.createCheckout.mutate({
        docket,
        returnUrl: `${window.location.origin}${window.location.pathname}${window.location.search}`,
      });
      const data = result as { ok?: boolean; status?: 'pending' | 'paid'; checkoutUrl?: string } | null;
      if (!data?.ok) {
        setStatus('unavailable');
        return;
      }
      setStatus(data.status ?? 'pending');
      setCheckoutUrl(data.checkoutUrl ?? null);
    } catch {
      setStatus('unavailable');
    }
  }, [docket]);

  const continueToDraft = useCallback(() => {
    if (docket) dispatch?.('paymentVerified', { docket });
  }, [dispatch, docket]);

  return (
    <section className="w-full">
      <div className="border border-border bg-card p-6 shadow-elevated sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
              {intl.formatMessage(messages.label)}
            </div>
            <h1 className="mt-1 text-balance font-display text-heading-xl font-semibold tracking-tight text-foreground">
              {intl.formatMessage(messages.heading)}
            </h1>
            <p className="mt-2 font-mono text-body-xs uppercase tracking-caps text-muted-foreground-subtle" translate="no">
              {intl.formatMessage(messages.preparedFor, { docket })}
            </p>
          </div>
          <span className="-rotate-2 border-2 border-primary px-3 py-1.5 font-mono text-body-sm tabular-nums text-primary">
            {amount}
          </span>
        </div>

        <dl className="mt-5 divide-y divide-border border-y border-border">
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-3">
            <dt className="text-body-sm text-foreground">{itemName}</dt>
            <dd className="font-mono text-body-sm tabular-nums text-foreground">{amount}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-3">
            <dt className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
              {intl.formatMessage(messages.oneTime)}
            </dt>
            <dd className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">1 ×</dd>
          </div>
        </dl>

        <p className="mt-5 max-w-[64ch] text-body-sm leading-relaxed text-muted-foreground">
          {intl.formatMessage(messages.safety)}
        </p>

        {status === 'paid' ? (
          <>
            <div className="mt-6 flex items-center gap-2 border-l-2 border-primary bg-muted px-4 py-3 text-body-sm text-foreground">
              <BadgeCheck className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
              {intl.formatMessage(messages.verified)}
            </div>
            <button
              type="button"
              onClick={continueToDraft}
              className="mt-4 flex w-full items-center justify-center gap-2 border-2 border-primary bg-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary-foreground transition hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98]"
            >
              {intl.formatMessage(messages.continue)}
            </button>
          </>
        ) : checkoutUrl ? (
          <>
            <a
              href={checkoutUrl}
              target="_self"
              rel="noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 border-2 border-primary bg-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary-foreground transition hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98]"
            >
              <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              {intl.formatMessage(messages.ready)}
            </a>
            <p className="mt-3 max-w-[64ch] text-body-xs leading-relaxed text-muted-foreground-subtle">
              {intl.formatMessage(messages.returnNote)}
            </p>
          </>
        ) : status === 'unavailable' ? (
          <p className="mt-6 border-l-2 border-primary px-3 text-body-sm text-foreground">
            {intl.formatMessage(messages.unavailable)}
          </p>
        ) : (
          <button
            type="button"
            onClick={createCheckout}
            disabled={!docket || status === 'loading'}
            className="mt-6 flex w-full items-center justify-center gap-2 border-2 border-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary transition hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {status === 'loading' ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <LockKeyhole className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            )}
            {status === 'loading' ? intl.formatMessage(messages.checking) : intl.formatMessage(messages.begin)}
          </button>
        )}
      </div>
    </section>
  );
};
