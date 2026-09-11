import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { records, text } from '../../util/fallback-props.ts';

interface ListItemGroup {
  section?: string;
  items: Record<string, unknown>[];
}

/** Groups items by their `section` field, preserving the order each distinct
 *  section (or the sectionless bucket) first appears — not just consecutive
 *  runs. Shared by the fallback markdown and (mirrored) the client renderer. */
function groupBySection(items: Record<string, unknown>[]): ListItemGroup[] {
  const groups: ListItemGroup[] = [];
  const groupIndexBySection = new Map<string | undefined, number>();
  for (const item of items) {
    const section = typeof item.section === 'string' && item.section ? item.section : undefined;
    let groupIndex = groupIndexBySection.get(section);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groupIndexBySection.set(section, groupIndex);
      groups.push({ section, items: [] });
    }
    groups[groupIndex]?.items.push(item);
  }
  return groups;
}

function formatItemLine(item: Record<string, unknown>): string {
  const title = typeof item.title === 'string' ? item.title : '';
  const value = typeof item.value === 'string' ? item.value : '';
  const description = typeof item.description === 'string' ? item.description : '';
  let line = `- ${title}`;
  if (value) {
    line += ` — ${value}`;
  }
  if (description) {
    line += `: ${description}`;
  }
  return line;
}

function listFallback(props: Record<string, unknown>): string {
  const title = text(props, 'title');
  const lines: string[] = [];
  if (title) {
    lines.push(`### ${title}`);
  }
  for (const group of groupBySection(records(props, 'items'))) {
    if (group.section) {
      lines.push(`**${group.section}**`);
    }
    for (const item of group.items) {
      lines.push(formatItemLine(item));
    }
  }
  return lines.filter(Boolean).join('\n');
}

export const LIST: ComponentContract = {
  component: 'List',
  purpose:
    'Displays rows of titled items — menus, FAQs, hours, features, results — optionally grouped into sections and optionally selectable.',
  fallbackTemplate: listFallback,
  props: {
    title: { type: 'string', description: 'Heading shown above the list' },
    items: {
      type: 'array',
      required: true,
      items: {
        id: {
          type: 'string',
          description: 'Stable identifier for this row, echoed back on selectItem',
        },
        title: { type: 'string', required: true, description: 'Row title' },
        description: { type: 'string', description: 'One-line supporting text under the title' },
        value: {
          type: 'string',
          description:
            'Trailing text shown at the end of the row (e.g. a price or time). PRE-FORMATTED — the component never computes it.',
        },
        section: {
          type: 'string',
          description:
            'Groups rows sharing the same section under one subheading, in first-appearance order',
        },
      },
      description: 'Rows to display, in order',
    },
    selectable: {
      type: 'boolean',
      description: 'When true, rows become tappable and dispatch selectItem on tap (default false)',
    },
  },
  publishes: {
    '/selection/itemId': { valueType: 'string' },
  },
  actions: {
    selectItem: {
      context: {
        id: { type: 'string', required: true, description: 'Selected row id' },
        title: { type: 'string', required: true, description: 'Selected row title' },
      },
    },
  },
};
