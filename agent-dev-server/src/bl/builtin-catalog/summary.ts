import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { records, text } from '../../util/fallback-props.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const SUMMARY: ComponentContract = {
  component: 'Summary',
  purpose:
    'The review-and-commit surface: an editable recap before any commitment, and its confirmed state after.',
  fallbackTemplate: summaryFallback,
  props: {
    title: { type: 'string', description: 'Heading shown above the summary' },
    lines: {
      type: 'array',
      required: true,
      items: {
        key: {
          type: 'string',
          required: true,
          description: 'Line id — becomes the data-model key suffix, publishes at /summary/{key}',
        },
        label: { type: 'string', required: true, description: 'Display label' },
        value: { type: 'string', required: true, description: 'The editable value' },
        caption: { type: 'string', description: 'Small helper text shown under the value' },
        editable: { type: 'boolean', description: 'Inline-editable (default true)' },
      },
      description: 'The full commitment, line by line — nothing hidden',
    },
    commitLabel: { type: 'string', required: true, description: 'Commit CTA label' },
    status: {
      type: 'string',
      enum: ['draft', 'committing', 'confirmed', 'failed'],
      description: 'Agent-driven via data model; defaults to draft',
    },
    statusNote: {
      type: 'string',
      description: 'Shown when status=failed (e.g. a retryable conflict)',
    },
    footnote: { type: 'string', description: 'Small helper text under the commit CTA' },
    confirmedTitle: { type: 'string', description: 'Success-hero title when status=confirmed' },
    confirmedSubtitle: {
      type: 'string',
      description: 'Success-hero subtitle when status=confirmed',
    },
  },
  // One key per line: a line with key "time" publishes to /summary/time.
  publishes: {
    '/summary/{key}': { valueType: 'string' },
  },
  actions: {
    commit: {
      context: {},
    },
  },
};

function summaryFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const title = text(props, 'title');
  const lines = records(props, 'lines').map((line) => {
    const label = typeof line.label === 'string' ? line.label : '';
    const value = typeof line.value === 'string' ? line.value : '';
    return `- ${label}: ${value}`;
  });
  const status = text(props, 'status');
  const statusValue = status
    ? formatServerMessage(localization, serverMessages.statusValue, { status })
    : '';
  const statusLine = statusValue
    ? `\n\n${formatServerMessage(localization, serverMessages.statusLine, {
        status: statusValue,
      })}`
    : '';
  const heading = title ? `## ${title}\n\n` : '';
  return `${heading}${lines.join('\n')}${statusLine}`;
}
