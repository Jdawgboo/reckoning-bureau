/**
 * `ChoiceBoard` builtin surface — pick one item from choices grouped into
 * columns (time slots by day, sizes by type, variants by group). Thin
 * binding: `columns[]` records → generic `ChoiceColumn`s; a column is
 * highlighted when it holds the current selection. Pick publishes
 * `/selection/choiceId`, then dispatches `selectChoice`.
 */
import { useContext, type FC } from 'react';
import { A2uiSurfaceContext } from '@/app/lib/a2ui/surface-context.ts';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { SurfaceHeader } from '@/app/lib/a2ui/blocks/SurfaceHeader.tsx';
import {
  ChoiceBoard as ChoiceBoardBlock,
  type ChoiceColumn,
  type ChoiceColumnItem,
} from '@/app/lib/a2ui/blocks/ChoiceBoard.tsx';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

interface ChoiceColumnRecord {
  heading: string;
  caption?: string;
  items: ChoiceColumnItem[];
}

function readItem(raw: unknown): ChoiceColumnItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = str(raw.id);
  const label = str(raw.label);
  if (!id || !label) {
    return null;
  }
  return {
    id,
    label,
    caption: optStr(raw.caption),
    disabled: raw.disabled === true,
  };
}

function readColumn(raw: unknown): ChoiceColumnRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const heading = str(raw.heading);
  if (!heading) {
    return null;
  }
  const items = arr(raw.items)
    .map(readItem)
    .filter((item): item is ChoiceColumnItem => item !== null);
  return { heading, caption: optStr(raw.caption), items };
}

export const ChoiceBoardSurface: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const intl = useIntl();
  const columns = arr(node.props.columns)
    .map(readColumn)
    .filter((column): column is ChoiceColumnRecord => column !== null);

  if (!Array.isArray(node.props.columns) || columns.length === 0) {
    return <BlockSkeleton variant="board" />;
  }

  const selectedId = optStr(node.props.selectedId);

  const blockColumns: ChoiceColumn[] = columns.map((column, index) => ({
    id: String(index),
    title: column.heading,
    caption: column.caption,
    highlight: selectedId !== undefined && column.items.some((item) => item.id === selectedId),
    items: column.items,
  }));

  const handlePick = (columnId: string, itemId: string) => {
    if (!api) {
      return;
    }
    const column = columns[Number(columnId)];
    const item = column?.items.find((candidate) => candidate.id === itemId);
    if (!item || item.disabled) {
      return;
    }
    api.setValue('/selection/choiceId', item.id);
    api.dispatch('selectChoice', { id: item.id, label: item.label });
  };

  return (
    <div>
      <SurfaceHeader
        title={str(node.props.title) || intl.formatMessage(messages.choices)}
        subtitle={optStr(node.props.subtitle)}
      />
      <ChoiceBoardBlock columns={blockColumns} selectedId={selectedId} onPick={handlePick} />
    </div>
  );
};
