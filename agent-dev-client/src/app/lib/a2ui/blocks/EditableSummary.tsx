/**
 * Generic commit receipt: editable lines + a single sheen CTA. Text "Edit"
 * links (no pencil glyph) toggle a line into an inline input; `committing`
 * disables the CTA and swaps its label; `failed` renders `statusNote` in the
 * caution treatment. Nothing here knows what a "booking" is — `key`/`label`/
 * `value` are opaque strings to this block.
 *
 * `onEdit(key)` fires on every tap of a line's "Edit" toggle; it cannot
 * carry an edited value on its own, so `onValueChange(key, value)` reports
 * the value separately as the inline input changes.
 */
import { type FC, useState } from 'react';
import { Button } from '@/app/lib/shadcdn/button';

export interface SummaryLine {
  key: string;
  label: string;
  value: string;
  caption?: string;
  editable?: boolean;
}

export interface EditableSummaryProps {
  lines: SummaryLine[];
  onEdit: (key: string) => void;
  onValueChange?: (key: string, value: string) => void;
  commitLabel: string;
  editLabel: string;
  committingLabel: string;
  onCommit: () => void;
  status?: 'draft' | 'committing' | 'confirmed' | 'failed';
  statusNote?: string;
  footnote?: string;
}

function commitButtonLabel(
  status: EditableSummaryProps['status'],
  commitLabel: string,
  committingLabel: string,
): string {
  if (status === 'committing') {
    return committingLabel;
  }
  return commitLabel;
}

export const EditableSummary: FC<EditableSummaryProps> = ({
  lines,
  onEdit,
  onValueChange,
  commitLabel,
  editLabel,
  committingLabel,
  onCommit,
  status = 'draft',
  statusNote,
  footnote,
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const busy = status === 'committing' || status === 'confirmed';

  return (
    <div>
      <div
        className="animate-fadeUp overflow-hidden rounded-lg border border-border bg-card"
        style={{ animationDelay: '60ms' }}
      >
        {lines.map((line) => {
          const locked = line.editable === false;
          const isEditing = editingKey === line.key;
          return (
            <div
              key={line.key}
              className="flex items-center gap-3 border-b border-border px-4.5 py-4 last:border-b-0"
            >
              <span className="w-[84px] flex-none text-sm text-muted-foreground-subtle">
                {line.label}
              </span>
              {isEditing ? (
                <input
                  className="w-full rounded-md border border-primary bg-muted px-2.5 py-1.5 text-base font-semibold text-foreground outline-none"
                  value={line.value}
                  // Focus follows the user's explicit "Edit" tap — element-level
                  // focus management, not page-load autofocus.
                  ref={(element) => element?.focus()}
                  onChange={(event) => onValueChange?.(line.key, event.target.value)}
                  onBlur={() => setEditingKey(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      setEditingKey(null);
                    }
                  }}
                />
              ) : (
                <span className="text-base font-semibold">
                  {line.value}
                  {line.caption ? (
                    <small className="block text-sm font-normal text-muted-foreground">
                      {line.caption}
                    </small>
                  ) : null}
                </span>
              )}
              {locked ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto rounded-md font-bold text-primary hover:bg-muted hover:text-primary"
                  onClick={() => {
                    setEditingKey(line.key);
                    onEdit(line.key);
                  }}
                >
                  {editLabel}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        className="mt-4 h-11 w-full animate-fadeUp rounded-lg text-sm font-semibold"
        style={{ animationDelay: '130ms' }}
        disabled={busy}
        onClick={onCommit}
      >
        {commitButtonLabel(status, commitLabel, committingLabel)}
      </Button>
      {status === 'failed' && statusNote ? (
        <div className="mt-2.5 text-center text-sm text-warning">{statusNote}</div>
      ) : null}
      {footnote ? (
        <div
          className="animate-fadeUp mt-2.5 text-center text-sm text-muted-foreground-subtle"
          style={{ animationDelay: '200ms' }}
        >
          {footnote}
        </div>
      ) : null}
    </div>
  );
};
