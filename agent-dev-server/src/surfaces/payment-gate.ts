import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * A single, opt-in hosted checkout handoff. The component calls the narrow
 * server-side payment bridge; the browser never handles payment credentials.
 */
export const PAYMENT_GATE: ComponentContract = {
  component: 'PaymentGate',
  purpose:
    'Shows the one-time filing fee only after an existing docket holder elects to issue paperwork. ' +
    'Render it before a paid demand-letter preparation. The component itself creates and verifies the hosted Stripe Checkout session only after the visitor presses its button. Never claim payment succeeded until the surface reports it verified.',
  props: {
    docket: {
      type: 'string',
      required: true,
      description: 'An existing registry docket number returned by the Bureau',
    },
    amountCents: {
      type: 'number',
      required: true,
      description: 'The filing fee in the smallest currency unit. The current approved fee is 2900 USD cents.',
    },
    currency: {
      type: 'string',
      required: true,
      description: 'Three-letter ISO currency code. The current approved currency is USD.',
    },
    itemName: {
      type: 'string',
      required: true,
      description: 'The concrete document-preparation item being purchased, not a subscription or plan',
    },
  },
  actions: {
    paymentVerified: {
      context: {
        docket: { type: 'string', required: true, description: 'The docket whose filing fee Stripe verified as paid' },
      },
    },
  },
  fallbackTemplate: (props) => {
    const item = typeof props.itemName === 'string' ? props.itemName : 'Document preparation';
    const fee = typeof props.amountCents === 'number' ? `${props.amountCents / 100}` : '';
    const currency = typeof props.currency === 'string' ? props.currency.toUpperCase() : '';
    return [
      `## Filing fee — ${item}`,
      fee ? `One-time fee: ${currency} ${fee}` : '',
      'Use the secure checkout control to continue. The Bureau does not take card details itself.',
    ]
      .filter(Boolean)
      .join('\n\n');
  },
};
