import { useCallback, type FC } from 'react';
import { ExternalLink, LockKeyhole } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { num, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';

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
    defaultMessage: 'After checkout, return here and tell us it is complete. We verify payment before preparing the issued document.',
  },
});

export const PaymentGate: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const docket = str(node.props.docket);
  const itemName = str(node.props.itemName);
  const currency = str(node.props.currency).toUpperCase() || 'USD';
  const amountCents = num(node.props.amountCents);
  const checkoutUrl = optStr(node.props.checkoutUrl);
  const amount = intl.formatNumber((amountCents ?? 0) / 100, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });

  const requestCheckout = useCallback(() => {
    if (!docket) return;
    const returnUrl = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
    if (!returnUrl) return;
    dispatch?.('requestCheckout', { docket, returnUrl });
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

        {checkoutUrl ? (
          <>
            <a
              href={checkoutUrl}
              target="_blank"
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
        ) : (
          <button
            type="button"
            onClick={requestCheckout}
            disabled={!docket}
            className="mt-6 flex w-full items-center justify-center gap-2 border-2 border-primary px-4 py-3 font-mono text-body-xs uppercase tracking-caps text-primary transition hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            <LockKeyhole className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {intl.formatMessage(messages.begin)}
          </button>
        )}
      </div>
    </section>
  );
};
