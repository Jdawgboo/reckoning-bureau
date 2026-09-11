import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { records, text } from '../../util/fallback-props.ts';

function stepMarker(state: string): string {
  if (state === 'done') {
    return '[x]';
  }
  if (state === 'active') {
    return '[>]';
  }
  return '[ ]';
}

function stepsFallback(props: Record<string, unknown>): string {
  const title = text(props, 'title');
  const lines: string[] = [];
  if (title) {
    lines.push(`### ${title}`);
  }
  for (const step of records(props, 'steps')) {
    const label = typeof step.label === 'string' ? step.label : '';
    const state = typeof step.state === 'string' ? step.state : 'pending';
    lines.push(`${stepMarker(state)} ${label}`);
  }
  return lines.filter(Boolean).join('\n');
}

export const STEPS: ComponentContract = {
  component: 'Steps',
  purpose:
    'Shows progress through a multi-step process — status tracking, onboarding, application stages.',
  fallbackTemplate: stepsFallback,
  props: {
    title: { type: 'string', description: 'Heading shown above the steps' },
    steps: {
      type: 'array',
      required: true,
      items: {
        label: { type: 'string', required: true, description: 'Step label' },
        caption: { type: 'string', description: 'One-line supporting text under the label' },
        state: {
          type: 'string',
          required: true,
          enum: ['pending', 'active', 'done'],
          description: 'Step status',
        },
      },
      description: 'Steps in order',
    },
  },
  publishes: {},
  actions: {},
};
