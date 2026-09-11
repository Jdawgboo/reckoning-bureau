/**
 * Builtin list surface: rows of titled items, optionally grouped under
 * section subheadings and optionally selectable. Selectable rows dispatch
 * `selectItem` through the per-surface `A2uiSurfaceApi`, mirroring how
 * `ButtonView` reaches `api.submit` in the base catalog.
 */
import { useContext, type FC } from 'react';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { A2uiSurfaceContext } from '@/app/lib/a2ui/surface-context.ts';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';

export interface ListItem {
  id: string;
  title: string;
  description?: string;
  value?: string;
  section?: string;
}

export interface ListProps {
  title?: string;
  items: ListItem[];
  selectable?: boolean;
}

interface ListItemGroup {
  section?: string;
  items: ListItem[];
}

/** Groups items by `section`, preserving the order each distinct section (or
 *  the sectionless bucket) first appears — not just consecutive runs. */
function groupBySection(items: ListItem[]): ListItemGroup[] {
  const groups: ListItemGroup[] = [];
  const groupIndexBySection = new Map<string | undefined, number>();
  for (const item of items) {
    let groupIndex = groupIndexBySection.get(item.section);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groupIndexBySection.set(item.section, groupIndex);
      groups.push({ section: item.section, items: [] });
    }
    groups[groupIndex]?.items.push(item);
  }
  return groups;
}

function toItems(value: unknown): ListItem[] {
  return arr(value)
    .filter(isRecord)
    .map((entry, index) => ({
      id: optStr(entry.id) ?? String(index),
      title: str(entry.title),
      description: optStr(entry.description),
      value: optStr(entry.value),
      section: optStr(entry.section),
    }));
}

const ListRow: FC<{ item: ListItem; selectable: boolean }> = ({ item, selectable }) => {
  const api = useContext(A2uiSurfaceContext);
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{item.title}</div>
        {item.description ? (
          <div className="text-sm text-muted-foreground">{item.description}</div>
        ) : null}
      </div>
      {item.value ? (
        <div className="shrink-0 pl-4 text-right tabular-nums text-muted-foreground">
          {item.value}
        </div>
      ) : null}
    </>
  );

  if (!selectable) {
    return (
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!api}
      onClick={() => api?.dispatch('selectItem', { id: item.id, title: item.title })}
      className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
    >
      {content}
    </button>
  );
};

const ListCard: FC<ListProps> = ({ title, items, selectable = false }) => {
  if (items.length === 0) {
    return <BlockSkeleton variant="board" />;
  }

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-card">
      {title ? (
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
        </div>
      ) : null}
      {groupBySection(items).map((group, groupIndex) => (
        <div key={group.section ?? `__ungrouped-${groupIndex}`}>
          {group.section ? (
            <div className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground-subtle">
              {group.section}
            </div>
          ) : null}
          {group.items.map((item) => (
            <ListRow key={item.id} item={item} selectable={selectable} />
          ))}
        </div>
      ))}
    </div>
  );
};

export const ListSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <ListCard
    title={optStr(node.props.title)}
    items={toItems(node.props.items)}
    selectable={node.props.selectable === true}
  />
);
