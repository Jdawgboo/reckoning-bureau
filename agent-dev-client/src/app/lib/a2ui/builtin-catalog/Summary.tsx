/**
 * `Summary` — the review-and-commit surface: an editable recap before any
 * commitment, and its confirmed state after. Thin binding: `lines[]` → the
 * shared `EditableSummary` block. Inline edits write to `/summary/{key}`;
 * `commit` dispatches with an empty context — the agent reads the whole
 * `/summary` namespace itself. Tapping "Edit" only opens the block's own
 * inline input — the reference this generalizes never dispatched an action
 * on edit either (no such action existed for it to fire), so `onEdit` stays
 * a local no-op and no edit action is declared in the contract.
 */
import { useContext, type FC } from 'react';
import { A2uiSurfaceContext } from '@/app/lib/a2ui/surface-context.ts';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { SurfaceHeader } from '@/app/lib/a2ui/blocks/SurfaceHeader.tsx';
import { EditableSummary, type SummaryLine } from '@/app/lib/a2ui/blocks/EditableSummary.tsx';
import { StatusHero } from '@/app/lib/a2ui/blocks/StatusHero.tsx';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type SummaryStatus = 'draft' | 'committing' | 'confirmed' | 'failed';

const STATUSES: ReadonlySet<string> = new Set(['draft', 'committing', 'confirmed', 'failed']);

function isSummaryStatus(value: string): value is SummaryStatus {
  return STATUSES.has(value);
}

function readLine(raw: unknown): SummaryLine | null {
  if (!isRecord(raw)) {
    return null;
  }
  const key = str(raw.key);
  const label = str(raw.label);
  const value = str(raw.value);
  if (!key || !label) {
    return null;
  }
  return {
    key,
    label,
    value,
    caption: optStr(raw.caption),
    editable: raw.editable !== false,
  };
}

function linePointer(key: string): string {
  return `/summary/${key}`;
}

const CONFIRMED_LINE_CLASS =
  'flex items-center gap-3 border-b border-border px-4.5 py-4 last:border-b-0';

/** Read-only line list shown alongside the success hero once `status` is
 *  `confirmed` — same row geometry as `EditableSummary`, minus the Edit
 *  toggle and commit CTA (there is nothing left to edit or commit). */
const ConfirmedLines: FC<{ lines: SummaryLine[] }> = ({ lines }) => (
  <div className="animate-fadeUp overflow-hidden rounded-lg border border-border bg-card">
    {lines.map((line) => (
      <div key={line.key} className={CONFIRMED_LINE_CLASS}>
        <span className="w-[84px] flex-none text-sm text-muted-foreground-subtle">
          {line.label}
        </span>
        <span className="text-base font-semibold">
          {line.value}
          {line.caption ? (
            <small className="block text-sm font-normal text-muted-foreground">
              {line.caption}
            </small>
          ) : null}
        </span>
      </div>
    ))}
  </div>
);

export const SummarySurface: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const intl = useIntl();
  const lines = arr(node.props.lines)
    .map(readLine)
    .filter((line): line is SummaryLine => line !== null);

  if (!Array.isArray(node.props.lines) || lines.length === 0) {
    return <BlockSkeleton variant="form" />;
  }

  const statusRaw = str(node.props.status);
  const status: SummaryStatus = isSummaryStatus(statusRaw) ? statusRaw : 'draft';

  // Inline edits write back through /summary/{key}, so the agent sees the
  // corrected value in shared state on the next turn.
  const displayLines: SummaryLine[] = lines.map((line) => {
    const written = api?.getValue(linePointer(line.key));
    const value = typeof written === 'string' && written.length > 0 ? written : line.value;
    return { ...line, value };
  });

  if (status === 'confirmed') {
    return (
      <div>
        <StatusHero
          tone="success"
          title={str(node.props.confirmedTitle) || intl.formatMessage(messages.confirmed)}
          subtitle={optStr(node.props.confirmedSubtitle)}
        />
        <ConfirmedLines lines={displayLines} />
      </div>
    );
  }

  const handleValueChange = (key: string, value: string) => {
    api?.setValue(linePointer(key), value);
  };

  const handleCommit = () => {
    api?.dispatch('commit', {});
  };

  const title = str(node.props.title);

  return (
    <div>
      {title ? <SurfaceHeader title={title} /> : null}
      <EditableSummary
        lines={displayLines}
        onEdit={() => {
          // Tapping "Edit" opens the inline input (block-internal); no
          // dispatch — no edit action is declared in this contract.
        }}
        onValueChange={handleValueChange}
        commitLabel={str(node.props.commitLabel) || intl.formatMessage(messages.confirm)}
        editLabel={intl.formatMessage(messages.edit)}
        committingLabel={intl.formatMessage(messages.confirming)}
        onCommit={handleCommit}
        status={status}
        statusNote={status === 'failed' ? optStr(node.props.statusNote) : undefined}
        footnote={optStr(node.props.footnote)}
      />
    </div>
  );
};
