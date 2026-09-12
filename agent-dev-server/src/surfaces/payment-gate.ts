import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * A single, opt-in hosted checkout handoff. The browser never handles payment
 * credentials; it asks the agent to create a Stripe Checkout session, then
 * leaves the card entry to Stripe's hosted page.
 */
export const PAYMENT_GATE: ComponentContract = {
  component: 'PaymentGate',
  purpose:
    'Shows the one-time filing fee only after an existing docket holder elects to issue paperwork. ' +
    'Render it before a paid demand-letter preparation. On requestCheckout, create exactly one hosted Stripe Checkout session for the stated amount and re-render this same surface with checkoutUrl. Never create a checkout before the visitor presses the button, and never claim payment succeeded until Stripe verifies it.',
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
    checkoutUrl: {
      type: 'string',
      description: 'Hosted Stripe Checkout URL returned by Stripe after the visitor opts in. Omit until a session is created.',
    },
  },
  actions: {
    requestCheckout: {
      context: {
        docket: { type: 'string', required: true, description: 'The docket purchasing this preparation item' },
        returnUrl: {
          type: 'string',
          required: true,
          description: 'The current Bureau page URL to use as the Stripe success and cancellation return base',
        },
      },
    },
  },
  fallbackTemplate: (props) => {
    const item = typeof props.itemName === 'string' ? props.itemName : 'Document preparation';
    const fee = typeof props.amountCents === 'number' ? `${props.amountCents / 100}` : '';
    const currency = typeof props.currency === 'string' ? props.currency.toUpperCase() : '';
    const checkoutUrl = typeof props.checkoutUrl === 'string' ? props.checkoutUrl : '';
    return [
      `## Filing fee — ${item}`,
      fee ? `One-time fee: ${currency} ${fee}` : '',
      'The Bureau creates a hosted checkout only after you choose to continue. It does not take card details itself.',
      checkoutUrl ? `[Continue to secure checkout](${checkoutUrl})` : 'Ask to continue to secure checkout when you are ready.',
    ]
      .filter(Boolean)
      .join('\n\n');
  },
};
