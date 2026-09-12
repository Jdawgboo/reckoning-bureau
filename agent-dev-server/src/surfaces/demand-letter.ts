import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * The demand letter, prepared for the claimant's own signature.
 *
 * The Bureau drafts; the visitor sends. The screen therefore ends in two acts —
 * copy the text, and record the issue in the register — and the second one is
 * what starts the response clock.
 */

export const DEMAND_LETTER: ComponentContract = {
  component: 'DemandLetter',
  purpose:
    'A formal letter before action, drafted for the visitor to send under their own name. ' +
    'Render it once a case file has a docket number and we know the counterparty, the facts, ' +
    'the amount and the remedy. Write the letter in full — every paragraph, no placeholders and ' +
    'no square brackets. Facts only from the file; never assert a statute, a right, a policy ' +
    'term or a consequence we have not been told or cannot see.',
  props: {
    docket: {
      type: 'string',
      required: true,
      description: 'The docket number of the case this letter belongs to, e.g. "RB-2025-0007"',
    },
    recipientName: {
      type: 'string',
      required: true,
      description: 'Who the letter is addressed to — the company or person, as known',
    },
    recipientLines: {
      type: 'array',
      description:
        'Address block lines for the recipient, one per line, only if the visitor gave them',
      items: { line: { type: 'string', required: true, description: 'One address line' } },
    },
    senderName: {
      type: 'string',
      required: true,
      description: 'The claimant, who will sign and send this. Their name as they gave it',
    },
    senderLines: {
      type: 'array',
      description: "The claimant's own address or contact lines, only if they gave them",
      items: { line: { type: 'string', required: true, description: 'One address or contact line' } },
    },
    subject: {
      type: 'string',
      required: true,
      description:
        'The subject line, specific enough to identify the matter, e.g. "Letter before action: ' +
        'deposit withheld, tenancy at 14 Ashgrove Road"',
    },
    paragraphs: {
      type: 'array',
      required: true,
      description:
        'The body, in order: what was agreed, what happened, what was already attempted, and ' +
        'what is now required. 3-6 paragraphs of flat, unemotional, factual prose',
      items: {
        text: { type: 'string', required: true, description: 'One complete paragraph' },
      },
    },
    demands: {
      type: 'array',
      required: true,
      description:
        'The numbered demands — each one a single, concrete, checkable action with its amount ' +
        'or object stated',
      items: {
        text: { type: 'string', required: true, description: 'One demand, e.g. "Refund £1,150 in full to the original payment method."' },
      },
    },
    deadlineDate: {
      type: 'string',
      required: true,
      description:
        'The response deadline as an ISO date (YYYY-MM-DD), normally 14 calendar days ahead. ' +
        'This is also the date our escalation clock will be set to',
    },
    consequence: {
      type: 'string',
      required: true,
      description:
        'One sentence on what the claimant will do if the deadline passes — only steps that are ' +
        'genuinely open to them (chargeback, the relevant ombudsman or scheme, a small claim). ' +
        'Never threaten anything else',
    },
  },
  actions: {
    demandIssued: {
      context: {
        docket: { type: 'string', required: true, description: 'The case this letter belongs to' },
        deadlineDate: {
          type: 'string',
          required: true,
          description: 'The ISO response deadline the visitor just committed to',
        },
        demoMode: {
          type: 'boolean',
          description: 'True only when the visible URL has tempo=demo; use the accelerated demonstration clock instead of a real schedule',
        },
      },
    },
    demoClockElapsed: {
      context: {
        docket: { type: 'string', required: true, description: 'The docket whose visible demonstration clock reached zero' },
      },
    },
  },
  fallbackTemplate: (props) => {
    const lines = Array.isArray(props.paragraphs) ? props.paragraphs : [];
    const demands = Array.isArray(props.demands) ? props.demands : [];
    const text = (row: unknown): string => {
      const entry = (row ?? {}) as Record<string, unknown>;
      return typeof entry.text === 'string' ? entry.text : '';
    };
    return [
      `## ${typeof props.subject === 'string' ? props.subject : 'Letter before action'}`,
      `Case ${typeof props.docket === 'string' ? props.docket : ''} — to ${
        typeof props.recipientName === 'string' ? props.recipientName : ''
      }`,
      ...lines.map(text),
      ...demands.map((row, index) => `${index + 1}. ${text(row)}`),
      typeof props.consequence === 'string' ? props.consequence : '',
      typeof props.senderName === 'string' ? `— ${props.senderName}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  },
};
