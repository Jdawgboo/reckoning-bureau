import type { FC } from 'react';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';

/**
 * Client half of the `MenuBoard` progressive-rendering example. The contract
 * composes one header node plus one node per item, so these two components each
 * render a single finished piece — nothing here knows or cares that the rest of
 * the list may still be arriving.
 */

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const MenuBoardHeader: FC<A2uiNodeViewProps> = ({ node }) => (
  <h2 className="text-xl font-semibold text-foreground">{text(node.props.title)}</h2>
);

interface MenuBoardItemProps {
  name?: unknown;
  price?: unknown;
  note?: unknown;
}

/**
 * The whole board as ONE component, keyed by the contract's own name. This is
 * the registration the platform requires — registry key equals
 * `contract.component` exactly — and it is what renders when `MenuBoard` is
 * placed as a section inside a `RenderSectionStack`: the stack emits a single
 * node per section and never runs the sub-contract's `compose`, so without
 * this the section falls back to "Unsupported component". The direct
 * `RenderMenuBoard` path streams via `compose`/`composePartial` into the two
 * piece components below instead.
 */
export const MenuBoard: FC<A2uiNodeViewProps> = ({ node }) => {
  const items = Array.isArray(node.props.items) ? (node.props.items as MenuBoardItemProps[]) : [];
  const title = text(node.props.title);
  return (
    <div>
      {title ? <h2 className="mb-2 text-xl font-semibold text-foreground">{title}</h2> : null}
      {items.map((item) => {
        const note = text(item.note);
        return (
          <div
            key={`${text(item.name)}-${text(item.price)}`}
            className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0"
          >
            <div>
              <div className="font-medium text-foreground">{text(item.name)}</div>
              {note ? <div className="text-sm text-muted-foreground">{note}</div> : null}
            </div>
            <div className="shrink-0 tabular-nums text-foreground">{text(item.price)}</div>
          </div>
        );
      })}
    </div>
  );
};

export const MenuBoardItem: FC<A2uiNodeViewProps> = ({ node }) => {
  const note = text(node.props.note);
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <div>
        <div className="font-medium text-foreground">{text(node.props.name)}</div>
        {note ? <div className="text-sm text-muted-foreground">{note}</div> : null}
      </div>
      <div className="shrink-0 tabular-nums text-foreground">{text(node.props.price)}</div>
    </div>
  );
};
