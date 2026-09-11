/**
 * Builtin steps surface: a vertical rail tracking progress through a
 * multi-step process. Purely presentational — no actions, no publishes. The
 * check glyph mirrors the one functional-status mark used in
 * `blocks/StatusHero.tsx`.
 */
import type { FC } from 'react';
import { cn } from '@/app/lib/utils';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';

type StepState = 'pending' | 'active' | 'done';

export interface Step {
  label: string;
  caption?: string;
  state: StepState;
}

export interface StepsProps {
  title?: string;
  steps: Step[];
}

function stepState(value: unknown): StepState {
  if (value === 'active' || value === 'done') {
    return value;
  }
  return 'pending';
}

function toSteps(value: unknown): Step[] {
  return arr(value)
    .filter(isRecord)
    .map((entry) => ({
      label: str(entry.label),
      caption: optStr(entry.caption),
      state: stepState(entry.state),
    }));
}

function stepLabelClassName(state: StepState): string {
  if (state === 'pending') {
    return 'font-medium text-muted-foreground';
  }
  return 'font-medium text-foreground';
}

const CheckGlyph: FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-3 w-3 fill-none stroke-current stroke-[3] [stroke-linecap:round] [stroke-linejoin:round]"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const StepMarker: FC<{ state: StepState }> = ({ state }) => {
  if (state === 'done') {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success text-success-foreground">
        <CheckGlyph />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-primary text-primary ring-2 ring-primary/20">
        <span className="h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  }
  return <span className="h-6 w-6 shrink-0 rounded-full border-2 border-border" />;
};

const StepsCard: FC<StepsProps> = ({ title, steps }) => {
  if (steps.length === 0) {
    return <BlockSkeleton variant="text" />;
  }

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4">
      {title ? <h3 className="mb-3 text-base font-semibold text-foreground">{title}</h3> : null}
      <div className="flex flex-col">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          const nextStep = steps[index + 1];
          const connectorColorClassName =
            nextStep && nextStep.state !== 'pending' ? 'bg-success' : 'bg-border';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps carry no stable id, order is the only identity
            <div key={index} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StepMarker state={step.state} />
                {!isLast ? <span className={cn('w-0.5 flex-1', connectorColorClassName)} /> : null}
              </div>
              <div className={isLast ? 'pt-0.5' : 'pb-5 pt-0.5'}>
                <div className={stepLabelClassName(step.state)}>{step.label}</div>
                {step.caption ? (
                  <div className="text-sm text-muted-foreground">{step.caption}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const StepsSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <StepsCard title={optStr(node.props.title)} steps={toSteps(node.props.steps)} />
);
