import type { FC } from 'react';
import { FileClock, FileQuestion, Gavel, KeyRound, PackageX, ReceiptText, Stamp } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';

/**
 * The Bureau's front desk. Stable chrome (the office line, the stamp, the
 * compliance footer, the lane numbering) is component-owned and localized here;
 * only the question, the lane wording and the procedure copy come from the
 * agent, already written in the committed session locale.
 */

const messages = defineMessages({
  office: {
    id: 'intakeDesk.office',
    defaultMessage: 'Office of claims & recovery',
  },
  stamp: {
    id: 'intakeDesk.stamp',
    defaultMessage: 'Open for intake',
  },
  laneNumber: {
    id: 'intakeDesk.laneNumber',
    defaultMessage: 'Lane {number}',
  },
  procedureHeading: {
    id: 'intakeDesk.procedureHeading',
    defaultMessage: 'How a case moves through this office',
  },
  disclaimer: {
    id: 'intakeDesk.disclaimer',
    defaultMessage:
      'Not a law firm and not legal advice. We prepare documents and manage your case file — you remain the party.',
  },
});

const LANE_ICONS = {
  'refund-refused': ReceiptText,
  'deposit-kept': KeyRound,
  'never-delivered': PackageX,
  'something-else': FileQuestion,
} as const;

const PROCEDURE_ICONS = [Stamp, Gavel, FileClock] as const;

interface Lane {
  id: string;
  label: string;
  detail: string;
}

interface Step {
  label: string;
  detail: string;
}

function readLanes(value: unknown): Lane[] {
  return arr(value).map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return { id: str(record.id), label: str(record.label), detail: str(record.detail) };
  });
}

function readSteps(value: unknown): Step[] {
  return arr(value).map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return { label: str(record.label), detail: str(record.detail) };
  });
}

export const IntakeDesk: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const headline = str(node.props.headline);
  const standfirst = str(node.props.standfirst);
  const lanes = readLanes(node.props.lanes);
  const steps = readSteps(node.props.procedure);

  return (
    <section className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-foreground/15 pb-4">
        <span className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
          {intl.formatMessage(messages.office)}
        </span>
        <span className="-rotate-2 border-2 border-primary/60 px-2.5 py-1 font-mono text-body-xs uppercase tracking-caps text-primary">
          {intl.formatMessage(messages.stamp)}
        </span>
      </div>

      <h1 className="mt-7 text-balance font-display text-heading-2xl font-semibold tracking-tight text-foreground md:text-heading-4xl">
        {headline}
      </h1>
      {standfirst ? (
        <p className="mt-3 max-w-[62ch] text-body-lg text-muted-foreground">{standfirst}</p>
      ) : null}

      {lanes.length > 0 ? (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {lanes.map((lane, index) => {
            const Icon = LANE_ICONS[lane.id as keyof typeof LANE_ICONS] ?? FileQuestion;
            return (
              <button
                key={lane.id || lane.label}
                type="button"
                onClick={() => dispatch?.('openLane', { laneId: lane.id, label: lane.label })}
                style={{ animationDelay: `${index * 70}ms` }}
                className="group animate-fadeUp rounded-md border border-border bg-card p-5 text-left transition duration-150 ease-out [touch-action:manipulation] hover:border-primary/50 hover:shadow-lift focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-95 motion-reduce:animate-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-muted text-foreground transition group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground-subtle">
                    {intl.formatMessage(messages.laneNumber, {
                      number: String(index + 1).padStart(2, '0'),
                    })}
                  </span>
                </div>
                <div className="mt-4 min-w-0">
                  <div className="font-display text-heading-sm font-semibold tracking-tight text-foreground">
                    {lane.label}
                  </div>
                  <div className="mt-1 text-body-sm text-muted-foreground">{lane.detail}</div>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="mt-10 border-t border-border pt-6">
          <h2 className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {intl.formatMessage(messages.procedureHeading)}
          </h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-3">
            {steps.map((step, index) => {
              const Icon = PROCEDURE_ICONS[index] ?? Stamp;
              return (
                <li key={step.label || index} className="min-w-0 border-l-2 border-primary/30 pl-3">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
                    <span className="font-display text-body-base font-semibold text-foreground">
                      {step.label}
                    </span>
                  </div>
                  <p className="mt-1 text-body-sm text-muted-foreground">{step.detail}</p>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <p className="mt-8 max-w-[62ch] font-mono text-body-xs leading-relaxed text-muted-foreground-subtle">
        {intl.formatMessage(messages.disclaimer)}
      </p>
    </section>
  );
};
