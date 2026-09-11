import { useCallback, useState, type FC, type ReactNode } from 'react';
import { Check, ClipboardCopy, Clock, Loader2, Square, Stamp } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';
import { trpc } from '@/app/lib/trpc';

/**
 * The escalation pack. The claimant lodges it; we record it.
 *
 * "I have lodged it" writes the kind-specific stamp to the register, moves the
 * file to ESCALATED, and dispatches `packLodged` so the agent can take the next
 * step in the same conversation.
 */

const messages = defineMessages({
  chargeback: { id: 'escalationPack.kind.chargeback', defaultMessage: 'Chargeback' },
  regulator: { id: 'escalationPack.kind.regulator', defaultMessage: 'Regulator referral' },
  smallClaim: { id: 'escalationPack.kind.smallClaim', defaultMessage: 'Small claim' },
  pack: { id: 'escalationPack.label', defaultMessage: 'Escalation pack' },
  lodgeWith: { id: 'escalationPack.lodgeWith', defaultMessage: 'To be lodged with' },
  facts: { id: 'escalationPack.facts', defaultMessage: 'What their form will ask' },
  statement: { id: 'escalationPack.statement', defaultMessage: 'Statement to paste' },
  attachments: { id: 'escalationPack.attachments', defaultMessage: 'Attach to the submission' },
  toObtain: { id: 'escalationPack.toObtain', defaultMessage: 'to obtain' },
  steps: { id: 'escalationPack.steps', defaultMessage: 'What you do' },
  copy: { id: 'escalationPack.copy', defaultMessage: 'Copy the statement' },
  copied: { id: 'escalationPack.copied', defaultMessage: 'Copied' },
  lodge: { id: 'escalationPack.lodge', defaultMessage: 'I have lodged it' },
  lodging: { id: 'escalationPack.lodging', defaultMessage: 'Entering it in the register…' },
  lodged: { id: 'escalationPack.lodged', defaultMessage: 'Escalated' },
  lodgeNote: {
    id: 'escalationPack.lodgeNote',
    defaultMessage:
      'You lodge it — we cannot submit on your behalf. Tell us once it is in and we record it against the docket.',
  },
  lodgeFailed: {
    id: 'escalationPack.lodgeFailed',
    defaultMessage: 'The register refused the entry. Nothing was recorded — try again.',
  },
});

const KIND_MESSAGES = {
  chargeback: messages.chargeback,
  regulator: messages.regulator,
  'small-claim': messages.smallClaim,
} as const;

/** Register vocabulary per lever — the stamp that lands on the docket. */
const KIND_STAMPS = {
  chargeback: 'CHARGEBACK LODGED',
  regulator: 'REFERRED TO REGULATOR',
  'small-claim': 'CLAIM FILED',
} as const;

type Kind = keyof typeof KIND_MESSAGES;

function texts(value: unknown): string[] {
  return arr(value)
    .map((entry) => str((entry as Record<string, unknown> | null)?.text))
    .filter((text) => text.length > 0);
}

const Label: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
    {children}
  </div>
);

export const EscalationPack: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const docket = str(node.props.docket);
  const rawKind = str(node.props.kind);
  const kind: Kind = rawKind in KIND_MESSAGES ? (rawKind as Kind) : 'regulator';
  const forumName = str(node.props.forumName);
  const forumNote = optStr(node.props.forumNote);
  const windowNote = optStr(node.props.windowNote);
  const headline = str(node.props.headline);
  const statement = texts(node.props.statement);
  const steps = texts(node.props.steps);
  const facts = arr(node.props.facts)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { label: str(row.label), value: str(row.value) };
    })
    .filter((row) => row.label.length > 0);
  const attachments = arr(node.props.attachments)
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return { label: str(row.label), held: row.held === true };
    })
    .filter((row) => row.label.length > 0);

  const [copied, setCopied] = useState(false);
  const [lodging, setLodging] = useState(false);
  const [lodged, setLodged] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(statement.join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (error) {
      console.error('[EscalationPack] copy failed:', error);
    }
  }, [statement]);

  const lodge = useCallback(async () => {
    setLodging(true);
    setFailed(false);
    try {
      const result = await trpc.cases.addEntry.mutate({
        docket,
        stamp: KIND_STAMPS[kind],
        note: `${headline} lodged with ${forumName} by the claimant.`,
        status: 'escalated',
        nextActionLabel: `Await the outcome from ${forumName}`,
        nextActionDueAt: null,
      });
      if ((result as { ok?: boolean } | null)?.ok !== true) {
        setFailed(true);
        return;
      }
      setLodged(true);
      dispatch?.('packLodged', { docket, kind, forumName });
    } catch (error) {
      console.error('[EscalationPack] lodging failed:', error);
      setFailed(true);
    } finally {
      setLodging(false);
    }
  }, [dispatch, docket, forumName, headline, kind]);

  return (
    <section className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-foreground/15 pb-4">
        <div className="min-w-0">
          <Label>
            {intl.formatMessage(messages.pack)} · {docket}
          </Label>
          <h1 className="mt-1 text-balance font-display text-heading-xl font-semibold tracking-tight text-foreground">
            {headline}
          </h1>
        </div>
        <span className="-rotate-2 border-2 border-primary px-3 py-1 font-mono text-body-sm uppercase tracking-caps text-primary">
          {intl.formatMessage(KIND_MESSAGES[kind])}
        </span>
      </div>

      <div className="mt-5">
        <Label>{intl.formatMessage(messages.lodgeWith)}</Label>
        <p className="mt-1 font-display text-heading-sm font-semibold text-foreground">
          {forumName}
        </p>
        {forumNote ? <p className="mt-1 text-body-sm text-muted-foreground">{forumNote}</p> : null}
      </div>

      {windowNote ? (
        <p className="mt-4 flex items-start gap-2 border-l-2 border-primary bg-muted p-3 text-body-sm text-foreground">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
          <span>{windowNote}</span>
        </p>
      ) : null}

      {facts.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.facts)}</Label>
          <dl className="mt-2 divide-y divide-border border-y border-border">
            {facts.map((row) => (
              <div key={row.label} className="flex flex-wrap gap-x-4 py-2">
                <dt className="w-56 shrink-0 font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
                  {row.label}
                </dt>
                <dd className="min-w-0 font-mono text-body-sm text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {statement.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.statement)}</Label>
          <div className="mt-2 border border-border bg-card p-5">
            {statement.map((paragraph, index) => (
              <p
                key={`s-${index}`}
                className={`max-w-[68ch] font-display text-body-base leading-relaxed text-foreground${
                  index > 0 ? ' mt-4' : ''
                }`}
              >
                {paragraph}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={copy}
            className="mt-3 flex items-center gap-2 border border-border bg-card px-4 py-2.5 font-mono text-body-xs uppercase tracking-caps text-foreground transition hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98]"
          >
            {copied ? (
              <Check className="h-4 w-4 text-primary" strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <ClipboardCopy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            )}
            {intl.formatMessage(copied ? messages.copied : messages.copy)}
          </button>
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.attachments)}</Label>
          <ul className="mt-2 space-y-2">
            {attachments.map((row) => (
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
                      row.held
                        ? 'text-body-sm text-foreground'
                        : 'text-body-sm text-muted-foreground'
                    }
                  >
                    {row.label}
                  </span>
                  {row.held ? null : (
                    <span className="ml-2 font-mono text-body-xs uppercase tracking-caps text-primary">
                      {intl.formatMessage(messages.toObtain)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="mt-6">
          <Label>{intl.formatMessage(messages.steps)}</Label>
          <ol className="mt-2 space-y-2">
            {steps.map((step, index) => (
              <li key={`t-${index}`} className="flex gap-3">
                <span className="font-mono text-body-sm tabular-nums text-primary">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 text-body-sm text-foreground">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="mt-8 border-t border-border pt-6">
        {lodged ? (
          <span className="inline-block -rotate-2 border-2 border-primary px-3 py-1.5 font-mono text-body-sm uppercase tracking-caps text-primary">
            {intl.formatMessage(messages.lodged)}
          </span>
        ) : (
          <button
            type="button"
            onClick={lodge}
            disabled={lodging || docket.length === 0}
            className="flex w-full items-center justify-center gap-2 border-2 border-primary px-5 py-3 font-mono text-body-sm uppercase tracking-caps text-primary transition duration-150 hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:opacity-60"
          >
            {lodging ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Stamp className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            )}
            {intl.formatMessage(lodging ? messages.lodging : messages.lodge)}
          </button>
        )}
        <p className="mt-3 max-w-[68ch] font-mono text-body-xs leading-relaxed text-muted-foreground-subtle">
          {intl.formatMessage(failed ? messages.lodgeFailed : messages.lodgeNote)}
        </p>
      </div>
    </section>
  );
};
