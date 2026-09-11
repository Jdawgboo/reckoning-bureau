import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { records, text } from '../../util/fallback-props.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const FORM: ComponentContract = {
  component: 'Form',
  purpose: 'Collects typed details from the visitor — contact info, preferences, requirements.',
  fallbackTemplate: formFallback,
  props: {
    title: { type: 'string', description: 'Heading shown above the form' },
    subtitle: { type: 'string', description: 'One-line description under the title' },
    fields: {
      type: 'array',
      required: true,
      items: {
        id: {
          type: 'string',
          required: true,
          description: 'Field id — becomes the data-model key suffix, publishes at /form/{id}',
        },
        label: { type: 'string', required: true, description: 'Field label' },
        kind: {
          type: 'string',
          required: true,
          enum: ['text', 'email', 'phone', 'choice', 'note'],
          description: 'Input kind; choice requires options',
        },
        options: {
          type: 'array',
          items: { type: 'string', description: 'Option value — also its display label' },
          description: 'For kind=choice: the selectable options',
        },
        value: { type: 'string', description: 'Initial/prefill value' },
        prefilled: { type: 'boolean', description: 'Shows the "pre-filled" tag on the field' },
        errors: {
          type: 'array',
          items: { type: 'string', description: 'Validation note' },
          description:
            'Validation notes the AGENT already computed — the component only displays them, it never validates',
        },
      },
      description: 'Agent-composed field list',
    },
    submitLabel: { type: 'string', required: true, description: 'Submit CTA label' },
    columns: {
      type: 'string',
      enum: ['1', '2'],
      description: 'Field grid columns; defaults to 2',
    },
  },
  // One key per field id: a field with id "email" publishes to /form/email.
  publishes: {
    '/form/{fieldId}': { valueType: 'string' },
  },
  actions: {
    submitForm: {
      context: {},
    },
  },
};

function formFallback(props: Record<string, unknown>, localization?: FallbackLocalization): string {
  const title = text(props, 'title');
  const submitLabel =
    text(props, 'submitLabel') || formatServerMessage(localization, serverMessages.submit);
  const lines = records(props, 'fields').map((field) => {
    const label = typeof field.label === 'string' ? field.label : '';
    const value = typeof field.value === 'string' ? field.value : '';
    return `- ${label}: ${value}`;
  });
  const heading = title ? `## ${title}\n\n` : '';
  return `${heading}${lines.join('\n')}\n\n${submitLabel}`;
}
