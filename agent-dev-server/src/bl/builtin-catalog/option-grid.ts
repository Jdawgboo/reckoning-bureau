import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { records, text } from '../../util/fallback-props.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const OPTION_GRID: ComponentContract = {
  component: 'OptionGrid',
  fallbackTemplate: optionGridFallback,
  purpose:
    'Lets the visitor browse a set of offerings — plans, services, products, rooms, classes — and pick one.',
  props: {
    title: { type: 'string', description: 'Heading shown above the grid' },
    subtitle: { type: 'string', description: 'One-line description under the title' },
    options: {
      type: 'array',
      required: true,
      items: {
        id: {
          type: 'string',
          required: true,
          description: 'Option id — the value published on select',
        },
        name: { type: 'string', required: true, description: 'Display name' },
        description: { type: 'string', description: 'One-line description' },
        price: {
          type: 'string',
          description:
            'Display price, PRE-FORMATTED by the model (e.g. "from $80") — component never computes money',
        },
        priceCaption: {
          type: 'string',
          description: 'Short caption shown alongside the price (e.g. "from", "/mo")',
        },
        imageUrl: {
          type: 'string',
          description: 'Optional media image shown at the top of the card',
        },
        featured: {
          type: 'boolean',
          description: 'Highlight this option with an animated ring — at most one per grid',
        },
        meta: {
          type: 'string',
          description: 'Short trailing note, e.g. duration ("45 min")',
        },
      },
      description: 'The offerings to choose from — never invented',
    },
  },
  publishes: {
    '/selection/optionId': { valueType: 'string' },
  },
  actions: {
    selectOption: {
      context: {
        id: { type: 'string', required: true, description: 'bound: /selection/optionId' },
        name: {
          type: 'string',
          required: true,
          description: 'Display name of the selected option',
        },
      },
    },
  },
};

function optionGridFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const title = text(props, 'title') || formatServerMessage(localization, serverMessages.options);
  const lines = records(props, 'options').map((option) => {
    const name = typeof option.name === 'string' ? option.name : '';
    const price = typeof option.price === 'string' && option.price ? ` — ${option.price}` : '';
    const description =
      typeof option.description === 'string' && option.description ? `: ${option.description}` : '';
    return `**${name}**${price}${description}`;
  });
  return `## ${title}\n\n${lines.join('\n')}`;
}
