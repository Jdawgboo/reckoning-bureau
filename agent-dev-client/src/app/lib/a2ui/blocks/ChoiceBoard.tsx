/**
 * Generic columns of selectable pills. No notion of days or slots here —
 * `ChoiceColumn`/item vocabulary is deliberately abstract so any
 * grouped-choice UI (not just scheduling) can reuse it.
 */
import type { FC } from 'react';

export interface ChoiceColumnItem {
  id: string;
  label: string;
  caption?: string;
  disabled?: boolean;
}

export interface ChoiceColumn {
  id: string;
  title: string;
  caption?: string;
  highlight?: boolean;
  items: ChoiceColumnItem[];
}

export interface ChoiceBoardProps {
  columns: ChoiceColumn[];
  selectedId?: string;
  onPick: (columnId: string, itemId: string) => void;
}

export const ChoiceBoard: FC<ChoiceBoardProps> = ({ columns, selectedId, onPick }) => (
  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
    {columns.map((column, index) => (
      <div
        key={column.id}
        className="animate-fadeUp rounded-lg border border-border bg-card p-3.5 data-[highlight=true]:border-primary"
        data-highlight={column.highlight === true}
        style={{ animationDelay: `${index * 70}ms` }}
      >
        <div className="mb-2.5 flex items-baseline justify-between text-sm font-bold">
          <span>{column.title}</span>
          {column.caption ? (
            <small className="text-xs font-medium text-muted-foreground-subtle">
              {column.caption}
            </small>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.75">
          {column.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="group flex min-h-11 w-full cursor-pointer items-center justify-between rounded-md border border-border bg-muted px-3 text-sm font-semibold tabular-nums text-foreground transition duration-150 hover:border-muted-foreground-subtle active:scale-[0.97] data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40 data-[selected=true]:border-primary data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground data-[selected=true]:shadow-elevated"
              data-selected={item.id === selectedId}
              data-disabled={item.disabled === true}
              disabled={item.disabled === true}
              onClick={() => onPick(column.id, item.id)}
            >
              <span>{item.label}</span>
              {item.caption ? (
                <small className="text-xs font-medium text-muted-foreground-subtle group-data-[selected=true]:text-primary-foreground group-data-[selected=true]:opacity-80">
                  {item.caption}
                </small>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    ))}
  </div>
);
