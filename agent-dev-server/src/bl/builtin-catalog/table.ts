import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord } from '../../util/type-guards.ts';

export const TABLE: ComponentContract = {
  component: 'Table',
  purpose: 'Displays tabular data with columns, rows, and an optional footer.',
  fallbackTemplate: tableFallback,
  props: {
    title: { type: 'string', description: 'Heading shown above the table' },
    description: { type: 'string', description: 'One-line description under the title' },
    caption: { type: 'string', description: 'Caption text displayed at the top of the table' },
    columns: {
      type: 'array',
      required: true,
      items: {
        header: {
          type: 'string',
          required: true,
          description: 'Text displayed in the table header',
        },
        accessor: {
          type: 'string',
          required: true,
          description: 'The key used to access the corresponding data from the row objects',
        },
      },
      description: 'Array of column definitions',
    },
    rows: {
      type: 'array',
      required: true,
      items: {
        type: 'array',
        description:
          "Array representing a single row of data. Each value corresponds to a column, in the same order as defined in 'columns'.",
        items: { type: 'string', description: 'Cell value' },
      },
      description: 'Table data: one array per row',
    },
    footer: {
      type: 'array',
      items: {
        content: {
          type: 'string',
          required: true,
          description: 'Content to display in the footer cell',
        },
        colSpan: { type: 'number', required: true, description: 'Number of columns to span' },
      },
      description: 'Array of footer cell definitions',
    },
  },
  publishes: {},
  actions: {},
};

function tableFallback(props: Record<string, unknown>): string {
  const columns = Array.isArray(props.columns) ? props.columns.filter(isRecord) : [];
  const headers = columns.map((column) => (typeof column.header === 'string' ? column.header : ''));
  const rows = Array.isArray(props.rows) ? props.rows.filter(Array.isArray) : [];
  const lines: string[] = [];
  if (typeof props.title === 'string' && props.title) {
    lines.push(`### ${props.title}`);
  }
  if (typeof props.caption === 'string' && props.caption) {
    lines.push(props.caption);
  }
  if (headers.length > 0) {
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      lines.push(
        `| ${row.map((cell: unknown) => (typeof cell === 'string' ? cell : '')).join(' | ')} |`,
      );
    }
  }
  const footer = Array.isArray(props.footer) ? props.footer.filter(isRecord) : [];
  if (footer.length > 0) {
    lines.push('');
    lines.push(
      footer.map((cell) => (typeof cell.content === 'string' ? cell.content : '')).join(' · '),
    );
  }
  return lines.filter(Boolean).join('\n');
}
