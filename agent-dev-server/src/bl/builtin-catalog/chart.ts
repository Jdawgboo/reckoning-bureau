import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord } from '../../util/type-guards.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const CHART: ComponentContract = {
  component: 'Chart',
  purpose: 'Visualizes numeric data as a bar, line, area, or pie chart.',
  fallbackTemplate: chartFallback,
  props: {
    chartType: {
      type: 'string',
      required: true,
      enum: ['bar', 'line', 'area', 'pie'],
      description:
        'bar = compare categories, line/area = change over time, pie = parts of a whole (few slices only)',
    },
    title: { type: 'string', description: 'Heading shown above the chart' },
    description: { type: 'string', description: 'One-line description under the title' },
    categories: {
      type: 'array',
      required: true,
      items: { type: 'string', description: 'Category label (x-axis tick or pie slice name)' },
      description: 'X-axis labels (or pie slice names), in display order',
    },
    series: {
      type: 'array',
      required: true,
      items: {
        label: { type: 'string', required: true, description: 'Series name (shown in the legend)' },
        values: {
          type: 'array',
          required: true,
          items: { type: 'number', description: 'Value' },
          description:
            "One number per category, same order as 'categories'. PRE-COMPUTED — the component never computes.",
        },
      },
      description:
        'The series to plot (1-6). Colors are assigned automatically — never specify them.',
    },
    stacked: { type: 'boolean', description: 'Stack bar/area series instead of grouping' },
  },
  publishes: {},
  actions: {},
};

function chartFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const categories = Array.isArray(props.categories)
    ? props.categories.map((c) => (typeof c === 'string' ? c : ''))
    : [];
  const series = Array.isArray(props.series) ? props.series.filter(isRecord) : [];
  const lines: string[] = [];
  if (typeof props.title === 'string' && props.title) {
    lines.push(`### ${props.title}`);
  }
  const labels = series.map((entry, index) =>
    typeof entry.label === 'string'
      ? entry.label
      : formatServerMessage(localization, serverMessages.seriesLabel, { number: index + 1 }),
  );
  lines.push(
    `| ${formatServerMessage(localization, serverMessages.categoryLabel)} | ${labels.join(' | ')} |`,
  );
  lines.push(`| --- | ${labels.map(() => '---').join(' | ')} |`);
  categories.forEach((category, rowIndex) => {
    const cells = series.map((entry) => {
      const values = Array.isArray(entry.values) ? entry.values : [];
      const value = values[rowIndex];
      return typeof value === 'number' ? String(value) : '';
    });
    lines.push(`| ${category} | ${cells.join(' | ')} |`);
  });
  return lines.filter(Boolean).join('\n');
}
