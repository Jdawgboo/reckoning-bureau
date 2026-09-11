/**
 * `OptionGrid` builtin surface — browse a set of offerings (plans, services,
 * products, rooms, classes) and pick one. Thin binding: `options[]` records
 * → generic `OptionCard`s. Price/priceCaption/meta are pre-formatted by the
 * model; this adapter never computes money or duration. Select publishes
 * `/selection/optionId`, then dispatches `selectOption`.
 */
import { useContext, type FC } from 'react';
import { A2uiSurfaceContext } from '@/app/lib/a2ui/surface-context.ts';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { SurfaceHeader } from '@/app/lib/a2ui/blocks/SurfaceHeader.tsx';
import { OptionCardGrid, type OptionCard } from '@/app/lib/a2ui/blocks/OptionCardGrid.tsx';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

interface OptionRecord {
  id: string;
  name: string;
  description?: string;
  price?: string;
  priceCaption?: string;
  imageUrl?: string;
  featured?: boolean;
  meta?: string;
}

function readOption(raw: unknown): OptionRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    description: optStr(raw.description),
    price: optStr(raw.price),
    priceCaption: optStr(raw.priceCaption),
    imageUrl: optStr(raw.imageUrl),
    featured: raw.featured === true,
    meta: optStr(raw.meta),
  };
}

function toOptionCard(option: OptionRecord, featuredLabel: string): OptionCard {
  return {
    id: option.id,
    title: option.name,
    description: option.description,
    value: option.price,
    valuePrefix: option.priceCaption,
    imageUrl: option.imageUrl,
    meta: option.meta,
    featured: option.featured,
    featuredLabel: option.featured ? featuredLabel : undefined,
  };
}

export const OptionGridSurface: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const intl = useIntl();
  const options = arr(node.props.options)
    .map(readOption)
    .filter((option): option is OptionRecord => option !== null);

  if (!Array.isArray(node.props.options) || options.length === 0) {
    return <BlockSkeleton variant="cards" />;
  }

  const handleSelect = (id: string) => {
    if (!api) {
      return;
    }
    const selected = options.find((option) => option.id === id);
    if (!selected) {
      return;
    }
    api.setValue('/selection/optionId', selected.id);
    api.dispatch('selectOption', { id: selected.id, name: selected.name });
  };

  return (
    <div>
      <SurfaceHeader
        title={str(node.props.title) || intl.formatMessage(messages.options)}
        subtitle={optStr(node.props.subtitle)}
      />
      <OptionCardGrid
        options={options.map((option) =>
          toOptionCard(option, intl.formatMessage(messages.featured)),
        )}
        onSelect={handleSelect}
        selectLabel={intl.formatMessage(messages.select)}
      />
    </div>
  );
};
