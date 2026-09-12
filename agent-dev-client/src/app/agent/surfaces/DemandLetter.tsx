import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { Check, ClipboardCopy, Clock, Loader2, Stamp } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';
import { trpc } from '@/app/lib/trpc';

/**
 * The letter, on the Bureau's paper, prepared for the claimant's signature.
 *
 * "Mark as issued" is the consequential act: it writes a DEMAND ISSUED entry to
 * the register and dispatches `demandIssued`, which is what lets the agent set
 * the escalation clock for the deadline the visitor just committed to.
 */

const messages = defineMessages({
  letterhead: { id: 'demandLetter.letterhead', defaultMessage: 'The Reckoning Bureau' },
  preparedFor: {
    id: 'demandLetter.preparedFor',
    defaultMessage: 'Prepared for the claimant’s signature',
  },
  ourRef: { id: 'demandLetter.ourRef', defaultMessage: 'Our ref' },
  subject: { id: 'demandLetter.subject', defaultMessage: 'Re' },
  salutation: { id: 'demandLetter.salutation', defaultMessage: 'Dear {recipient},' },
  demandsHeading: { id: 'demandLetter.demandsHeading', defaultMessage: 'I require the following:' },
  deadline: {
    id: 'demandLetter.deadline',
    defaultMessage: 'A written response is required by {date}.',
  },
  closing: { id: 'demandLetter.closing', defaultMessage: 'Yours faithfully,' },
  copy: { id: 'demandLetter.copy', defaultMessage: 'Copy the letter' },
  copied: { id: 'demandLetter.copied', defaultMessage: 'Copied' },
  issue: { id: 'demandLetter.issue', defaultMessage: 'I have sent it — start the clock' },
  issuing: { id: 'demandLetter.issuing', defaultMessage: 'Entering it in the register…' },
  issued: { id: 'demandLetter.issued', defaultMessage: 'Demand issued' },
  issueNote: {
    id: 'demandLetter.issueNote',
    defaultMessage:
      'We do not send anything for you. Send it yourself, then tell us — we record the issue against the docket and watch the deadline.',
  },
  issueFailed: {
    id: 'demandLetter.issueFailed',
    defaultMessage: 'The register refused the entry. Nothing was recorded — try again.',
  },
  demoBand: { id: 'demandLetter.demoBand', defaultMessage: 'Accelerated — demonstration' },
  demoRunning: { id: 'demandLetter.demoRunning', defaultMessage: 'Deadline elapses in {seconds}s' },
  demoRealDate: {
    id: 'demandLetter.demoRealDate',
    defaultMessage: 'Preview only. The letter keeps its real calendar deadline.',
  },
  demoDrafting: {
    id: 'demandLetter.demoDrafting',
    defaultMessage: 'Deadline elapsed · drafting escalation #1',
  },
  demoFailed: {
    id: 'demandLetter.demoFailed',
    defaultMessage: 'The demonstration clock could not complete. The real case record is unchanged.',
  },
});

function lines(value: unknown): string[] {
  return arr(value)
    .map((entry) => str((entry as Record<string, unknown> | null)?.line))
    .filter((line) => line.length > 0);
}

function texts(value: unknown): string[] {
  return arr(value)
    .map((entry) => str((entry as Record<string, unknown> | null)?.text))
    .filter((text) => text.length > 0);
}

export const DemandLetter: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const docket = str(node.props.docket);
  const recipientName = str(node.props.recipientName);
  const senderName = str(node.props.senderName);
  const subject = str(node.props.subject);
  const deadlineDate = str(node.props.deadlineDate);
  const consequence = str(node.props.consequence);
  const recipientLines = lines(node.props.recipientLines);
  const senderLines = lines(node.props.senderLines);
  const paragraphs = texts(node.props.paragraphs);
  const demands = texts(node.props.demands);

  const [copied, setCopied] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState(false);
  const [failed, setFailed] = useState(false);
  const [demoClock, setDemoClock] = useState<{ endsAt: number; seconds: number } | null>(null);
  const [demoRemaining, setDemoRemaining] = useState<number | null>(null);
  const [demoDrafting, setDemoDrafting] = useState(false);
  const [demoFailed, setDemoFailed] = useState(false);
  const demoFired = useRef(false);
  const demoMode =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tempo') === 'demo';

  const deadlineLabel = deadlineDate
    ? intl.formatDate(deadlineDate, { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const today = intl.formatDate(new Date(), { day: 'numeric', month: 'long', year: 'numeric' });

  const plainText = [
    senderLines.join('\n'),
    today,
    [recipientName, ...recipientLines].join('\n'),
    `${intl.formatMessage(messages.subject)}: ${subject}`,
    intl.formatMessage(messages.salutation, { recipient: recipientName }),
    paragraphs.join('\n\n'),
    `${intl.formatMessage(messages.demandsHeading)}\n${demands
      .map((demand, index) => `${index + 1}. ${demand}`)
      .join('\n')}`,
    intl.formatMessage(messages.deadline, { date: deadlineLabel }),
    consequence,
    `${intl.formatMessage(messages.closing)}\n${senderName}`,
  ]
    .filter((block) => block.trim().length > 0)
    .join('\n\n');

  useEffect(() => {
    if (!demoClock || demoFired.current) {
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((demoClock.endsAt - Date.now()) / 1000));
      setDemoRemaining(remaining);
      if (remaining > 0 || demoFired.current) {
        return;
      }
      demoFired.current = true;
      setDemoDrafting(true);
      void trpc.cases
        .completeDemoClock.mutate({ docket })
        .then((result) => {
          if ((result as { ok?: boolean } | null)?.ok !== true) {
            setDemoFailed(true);
            setDemoDrafting(false);
            return;
          }
          dispatch?.('demoClockElapsed', { docket });
        })
        .catch((error) => {
          console.error('[DemandLetter] demonstration clock failed:', error);
          setDemoFailed(true);
          setDemoDrafting(false);
        });
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [demoClock, dispatch, docket]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (error) {
      console.error('[DemandLetter] copy failed:', error);
    }
  }, [plainText]);

  const markIssued = useCallback(async () => {
    setIssuing(true);
    setFailed(false);
    try {
      const result = await trpc.cases.addEntry.mutate({
        docket,
        stamp: 'DEMAND ISSUED',
        note: `Letter before action sent to ${recipientName}. Response required by ${deadlineDate}.`,
        status: 'demand_issued',
        nextActionLabel: 'Await response; escalate if the deadline passes',
        nextActionDueAt: deadlineDate,
      });
      if ((result as { ok?: boolean } | null)?.ok !== true) {
        setFailed(true);
        return;
      }
      if (demoMode) {
        const demo = await trpc.cases.startDemoClock.mutate({ docket, seconds: 16 });
        if ((demo as { ok?: boolean } | null)?.ok !== true) {
          setDemoFailed(true);
        } else {
          setDemoClock({ endsAt: Date.now() + 16_000, seconds: 16 });
          setDemoRemaining(16);
        }
      }
      setIssued(true);
      dispatch?.('demandIssued', { docket, deadlineDate, demoMode });
    } catch (error) {
      console.error('[DemandLetter] issue failed:', error);
      setFailed(true);
    } finally {
      setIssuing(false);
    }
  }, [deadlineDate, dispatch, docket, recipientName]);

  return (
    <section className="w-full">
      <div className="border border-border bg-card p-6 shadow-elevated sm:p-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-foreground/80 pb-3">
          <span
            className="font-display text-heading-sm font-bold uppercase tracking-caps text-foreground"
            translate="no"
          >
            {intl.formatMessage(messages.letterhead)}
          </span>
          <span className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {intl.formatMessage(messages.preparedFor)}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap justify-between gap-x-8 gap-y-2 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
          <span>
            {intl.formatMessage(messages.ourRef)}: <span className="text-foreground">{docket}</span>
          </span>
          <span>{today}</span>
        </div>

        {senderLines.length > 0 ? (
          <div className="mt-6 text-body-sm text-muted-foreground">
            {senderLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : null}

        <div className="mt-6 text-body-sm text-foreground">
          <div className="font-medium">{recipientName}</div>
          {recipientLines.map((line) => (
            <div key={line} className="text-muted-foreground">
              {line}
            </div>
          ))}
        </div>

        <p className="mt-6 font-mono text-body-sm uppercase tracking-caps text-foreground">
          {intl.formatMessage(messages.subject)}: {subject}
        </p>

        <div className="mt-6 max-w-[68ch] font-display text-body-base leading-relaxed text-foreground">
          <p>{intl.formatMessage(messages.salutation, { recipient: recipientName })}</p>
          {paragraphs.map((paragraph, index) => (
            <p key={`p-${index}`} className="mt-4">
              {paragraph}
            </p>
          ))}

          {demands.length > 0 ? (
            <>
              <p className="mt-5 font-semibold">{intl.formatMessage(messages.demandsHeading)}</p>
              <ol className="mt-2 space-y-2">
                {demands.map((demand, index) => (
                  <li key={`d-${index}`} className="flex gap-3">
                    <span className="font-mono text-body-sm tabular-nums text-primary">
                      {index + 1}.
                    </span>
                    <span>{demand}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          {deadlineLabel ? (
            <p className="mt-5 border-l-2 border-primary pl-3 font-semibold">
              {intl.formatMessage(messages.deadline, { date: deadlineLabel })}
            </p>
          ) : null}

          {consequence ? <p className="mt-4">{consequence}</p> : null}

          <p className="mt-8">{intl.formatMessage(messages.closing)}</p>
          <p className="mt-6 border-b border-dashed border-muted-foreground-subtle pb-1 font-mono text-body-sm text-foreground">
            {senderName}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-2 border border-border bg-card px-4 py-2.5 font-mono text-body-xs uppercase tracking-caps text-foreground transition hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98]"
        >
          {copied ? (
            <Check className="h-4 w-4 text-primary" strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <ClipboardCopy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          )}
          {intl.formatMessage(copied ? messages.copied : messages.copy)}
        </button>

        {issued ? (
          <span className="-rotate-2 border-2 border-primary px-3 py-1.5 font-mono text-body-sm uppercase tracking-caps text-primary">
            {intl.formatMessage(messages.issued)}
          </span>
        ) : (
          <button
            type="button"
            onClick={markIssued}
            disabled={issuing || docket.length === 0}
            className="flex items-center gap-2 border-2 border-primary px-4 py-2.5 font-mono text-body-xs uppercase tracking-caps text-primary transition hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {issuing ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Stamp className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            )}
            {intl.formatMessage(issuing ? messages.issuing : messages.issue)}
          </button>
        )}
      </div>

      <p className="mt-3 max-w-[68ch] font-mono text-body-xs leading-relaxed text-muted-foreground-subtle">
        {intl.formatMessage(failed ? messages.issueFailed : messages.issueNote)}
      </p>

      {demoMode && issued ? (
        <section className="mt-6 border-2 border-primary/70 bg-muted" aria-live="polite">
          <div className="flex items-center gap-2 border-b border-primary/50 bg-primary px-4 py-2 font-mono text-body-xs uppercase tracking-caps text-primary-foreground">
            <Clock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {intl.formatMessage(messages.demoBand)}
          </div>
          <div className="p-4">
            {demoDrafting ? (
              <p className="font-mono text-body-sm uppercase tracking-caps text-primary">
                {intl.formatMessage(messages.demoDrafting)}
              </p>
            ) : demoClock && demoRemaining !== null ? (
              <p className="font-display text-heading-lg font-semibold tabular-nums text-foreground">
                {intl.formatMessage(messages.demoRunning, { seconds: demoRemaining })}
              </p>
            ) : null}
            <p className="mt-2 max-w-[62ch] text-body-xs leading-relaxed text-muted-foreground">
              {intl.formatMessage(demoFailed ? messages.demoFailed : messages.demoRealDate)}
            </p>
          </div>
        </section>
      ) : null}
    </section>
  );
};
