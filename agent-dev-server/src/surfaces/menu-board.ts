import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import type { A2uiComponentNode } from '../../vendor/agentplace-a2ui/types.ts';
import {
  settledArrayPrefix,
  settledStringProp,
} from '../../vendor/agentplace-a2ui/partial-input.ts';
import { formatServerMessage, serverMessages } from '../services/server-localization-messages.ts';

/**
 * Worked example of progressive rendering for an authored screen.
 *
 * A catalog is the case that suffers most from atomic rendering: an ordinary
 * `Render<Component>` shows nothing until every item, price and note has been
 * generated, so a long list leaves the visitor on a skeleton for as long as the
 * payload takes to write. Supplying `compose` + `composePartial` makes each
 * finished item appear while the rest are still being written.
 *
 * The completeness rule is the whole point and the only subtle part: an item
 * counts as finished once a LATER item has started. The last item seen in a
 * partial parse is never emitted, because a partial parse gives no signal that
 * it has stopped growing — a half-written price is worse than a skeleton.
 */

interface MenuItem {
  name: string;
  price: string;
  note?: string;
}

const ROOT_COMPONENT = 'Column';
const HEADER_NODE_ID = 'menu-header';

function readItems(props: Record<string, unknown>): MenuItem[] {
  const raw = props.items;
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: MenuItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record: Record<string, unknown> = { ...entry };
    items.push({
      name: typeof record.name === 'string' ? record.name : '',
      price: typeof record.price === 'string' ? record.price : '',
      note: typeof record.note === 'string' ? record.note : undefined,
    });
  }
  return items;
}

function itemNodeId(index: number): string {
  return `menu-item-${index}`;
}

function buildNodes(title: string, items: MenuItem[]): A2uiComponentNode[] {
  const hasHeader = title.length > 0;
  const childIds = [
    ...(hasHeader ? [HEADER_NODE_ID] : []),
    ...items.map((_, index) => itemNodeId(index)),
  ];
  return [
    { id: 'root', component: ROOT_COMPONENT, children: childIds },
    ...(hasHeader ? [{ id: HEADER_NODE_ID, component: 'MenuBoardHeader', title }] : []),
    ...items.map((item, index) => ({
      id: itemNodeId(index),
      component: 'MenuBoardItem',
      name: item.name,
      price: item.price,
      ...(item.note === undefined ? {} : { note: item.note }),
    })),
  ];
}

function compose(props: Record<string, unknown>): A2uiComponentNode[] {
  const title = typeof props.title === 'string' ? props.title : '';
  return buildNodes(title, readItems(props));
}

/**
 * Emits whatever is already finished: the header once the title has settled,
 * plus the leading run of items that a later item has displaced. Neither waits
 * for the other — the model writes these arguments in whatever order its
 * schema produces, so gating the items behind the title would silently disable
 * streaming for any screen whose title happens to be written last.
 *
 * The displacement test (a value is settled only when a later sibling has
 * started) applies to both the title and items — see `settledStringProp` and
 * `settledArrayPrefix` in the shared a2ui library.
 */
function composePartial(partialProps: Record<string, unknown>): { nodes: A2uiComponentNode[] } {
  const title = settledStringProp(partialProps, 'title');
  const ready = settledArrayPrefix(readItems(partialProps), (item) => item.name.length > 0);
  if (title.length === 0 && ready.length === 0) {
    return { nodes: [] };
  }
  return { nodes: buildNodes(title, ready) };
}

export const MENU_BOARD: ComponentContract = {
  component: 'MenuBoard',
  purpose:
    'A list of offerings with prices — menu, service list, package tiers. Render it when the ' +
    'visitor asks what is on offer. Items appear one at a time as they are written, so put the ' +
    'items the visitor most likely wants first.',
  props: {
    title: {
      type: 'string',
      required: true,
      description: 'The real subject of the list, e.g. "Breakfast until 11:30" — never filler',
    },
    items: {
      type: 'array',
      required: true,
      items: {
        name: { type: 'string', required: true, description: 'What it is called' },
        price: {
          type: 'string',
          required: true,
          description: 'Display price as the visitor should read it, e.g. "€4.50"',
        },
        note: { type: 'string', description: 'One short line — allergens, portion, availability' },
      },
      description: 'Offerings in the order the visitor should see them',
    },
  },
  publishes: {},
  actions: {},
  compose,
  composePartial,
  fallbackTemplate: (props, localization) => {
    const title =
      typeof props.title === 'string'
        ? props.title
        : formatServerMessage(localization, serverMessages.menu);
    const lines = readItems(props).map(
      (item) => `- ${item.name} — ${item.price}${item.note ? ` (${item.note})` : ''}`,
    );
    return `## ${title}\n\n${lines.join('\n')}`;
  },
};
