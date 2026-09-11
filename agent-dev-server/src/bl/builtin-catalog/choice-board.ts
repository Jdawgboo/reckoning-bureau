import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord } from '../../util/type-guards.ts';
import { records, text } from '../../util/fallback-props.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const CHOICE_BOARD: ComponentContract = {
  component: 'ChoiceBoard',
  fallbackTemplate: choiceBoardFallback,
  purpose:
    'Lets the visitor pick one option from choices grouped into columns — time slots by day, sizes by type, variants by group.',
  props: {
    title: { type: 'string', description: 'Heading shown above the board' },
    subtitle: { type: 'string', description: 'One-line description under the title' },
    columns: {
      type: 'array',
      required: true,
      items: {
        heading: { type: 'string', required: true, description: 'Column heading' },
        caption: { type: 'string', description: 'Short trailing note next to the heading' },
        items: {
          type: 'array',
          required: true,
          items: {
            id: {
              type: 'string',
              required: true,
              description: 'Item id — the value published on select',
            },
            label: { type: 'string', required: true, description: 'Display label' },
            caption: { type: 'string', description: 'Short trailing note next to the label' },
            disabled: {
              type: 'boolean',
              description: 'Gray out and disable this item (e.g. unavailable)',
            },
          },
          description: 'The selectable items in this column',
        },
      },
      description: 'The grouped columns of choices — never invented',
    },
    selectedId: {
      type: 'string',
      description:
        'Currently selected item id, highlighted in place. Re-render the same surfaceId with an updated value to reflect a new selection.',
    },
  },
  publishes: {
    '/selection/choiceId': { valueType: 'string' },
  },
  actions: {
    selectChoice: {
      context: {
        id: { type: 'string', required: true, description: 'bound: /selection/choiceId' },
        label: {
          type: 'string',
          required: true,
          description: 'Display label of the selected item',
        },
      },
    },
  },
};

function choiceBoardFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const title = text(props, 'title') || formatServerMessage(localization, serverMessages.choices);
  const lines: string[] = [];
  for (const column of records(props, 'columns')) {
    const heading = typeof column.heading === 'string' ? column.heading : '';
    lines.push(`**${heading}**`);
    const items = Array.isArray(column.items) ? column.items.filter(isRecord) : [];
    for (const item of items) {
      const label = typeof item.label === 'string' ? item.label : '';
      const caption = typeof item.caption === 'string' && item.caption ? ` (${item.caption})` : '';
      const itemText = `${label}${caption}`;
      const displayed =
        item.disabled === true
          ? formatServerMessage(localization, serverMessages.unavailableSuffix, {
              label: itemText,
            })
          : itemText;
      lines.push(`- ${displayed}`);
    }
  }
  return `## ${title}\n\n${lines.join('\n')}`;
}
