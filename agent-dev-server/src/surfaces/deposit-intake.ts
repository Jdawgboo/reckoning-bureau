import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * A deposit-withheld intake is tightly coupled: every field is saved to an
 * unfiled server-side draft before the screen advances. The final action hands
 * the exact stored record to the agent for the claimant's CaseFile review.
 */
export const DEPOSIT_INTAKE: ComponentContract = {
  component: 'DepositIntake',
  purpose:
    'Runs the deposit-withheld intake. Render this instead of a generic Form or SectionStack when the visitor selects the deposit-kept lane. The screen collects one fact at a time and stores it server-side before advancing. Do not ask these facts in chat. When it sends depositDraftReady, the draft context is the authoritative unfiled record: use its exact values to render CaseFile without deleting or re-asking them.',
  props: {},
  actions: {
    depositDraftReady: {
      context: {
        draft: {
          type: 'string',
          required: true,
          description:
            'JSON for the complete server-held, unfiled deposit intake record. This is the source of truth for the final CaseFile review. Use only these values; do not re-infer facts from chat history or erase a recorded field.',
        },
      },
    },
  },
  fallbackTemplate: () =>
    '## Deposit withheld intake\n\nThis intake is available in the web workspace, where each saved detail is recorded before the next question.',
};
