/**
 * Default interim page for ANY long-running tool part with no dedicated
 * process page — the floor that keeps every tool visible while it works,
 * so a missing registry entry degrades to a plain working card instead of
 * an unexplained frozen screen. Dedicated pages (DeepResearch) are the
 * upgrade, never the requirement.
 */
import type { FC } from 'react';
import type { ComponentContent } from '../../../../../vendor/agent-library/types/content.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

const MAX_DETAIL_CHARS = 140;

function humanizeToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** The one short string a tool's streamed input most often carries for a human. */
function primaryDetail(part: ComponentContent): string | null {
  const input = part.streaming?.input;
  if (!input) {
    return null;
  }
  for (const key of ['query', 'instruction', 'description', 'title']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value;
    }
  }
  return null;
}

export const GenericProcessPage: FC<{ part: ComponentContent }> = ({ part }) => {
  const intl = useIntl();
  const name = part.streaming?.toolName ?? part.componentName;
  const detail = primaryDetail(part);
  return (
    <div className="stage-process-page">
      <div className="mx-auto mt-16 flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <div className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground" />
        <div className="text-base font-medium text-foreground">{humanizeToolName(name)}</div>
        {detail ? <div className="text-sm text-muted-foreground">{detail}</div> : null}
        <div className="text-xs text-muted-foreground">{intl.formatMessage(messages.working)}</div>
      </div>
    </div>
  );
};
