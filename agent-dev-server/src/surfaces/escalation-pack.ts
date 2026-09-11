import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * The escalation pack: everything the claimant needs to lodge the next lever
 * themselves — a card chargeback, a referral to a regulator or redress scheme,
 * or a small claim.
 *
 * One contract for all three because the shape is the same: a forum, the facts
 * its form will demand, a statement to paste, the documents to attach, and the
 * steps to take. Lodging it stamps the docket and moves the file to ESCALATED.
 */

export const ESCALATION_PACK: ComponentContract = {
  component: 'EscalationPack',
  purpose:
    'The next lever after a demand was ignored, prepared for the claimant to lodge. Render it ' +
    'when the deadline has passed or the counterparty has refused, and only for a forum that ' +
    'genuinely applies to this claimant — ask how they paid and where they are before naming ' +
    'one. Write the statement in full, ready to paste. Never invent a reason code, a time limit, ' +
    'a fee, a form name or a submission address; leave the field out instead.',
  props: {
    docket: {
      type: 'string',
      required: true,
      description: 'The docket number this pack belongs to, e.g. "RB-2025-0007"',
    },
    kind: {
      type: 'string',
      required: true,
      enum: ['chargeback', 'regulator', 'small-claim'],
      description:
        'chargeback = card issuer or payment provider dispute; regulator = ombudsman, redress ' +
        'scheme or statutory regulator; small-claim = a money claim in the civil courts',
    },
    forumName: {
      type: 'string',
      required: true,
      description:
        'Exactly who receives this, as the claimant will address it, e.g. "Monzo disputes team" ' +
        'or "Financial Ombudsman Service". Use only a forum established in the conversation',
    },
    forumNote: {
      type: 'string',
      description:
        'One line on how it is lodged (app, online form, post), only when we actually know it',
    },
    windowNote: {
      type: 'string',
      description:
        'One line on the time limit that applies and what it runs from — only when it is a limit ' +
        'we know applies to this claimant, otherwise omit entirely',
    },
    headline: {
      type: 'string',
      required: true,
      description: 'What is being lodged, in a few words, e.g. "Chargeback: services not rendered"',
    },
    facts: {
      type: 'array',
      required: true,
      description:
        'The structured entries the form will demand, each taken from the file — transaction ' +
        'date, amount, merchant descriptor, prior demand date, and so on',
      items: {
        label: { type: 'string', required: true, description: 'The field as the form names it' },
        value: {
          type: 'string',
          required: true,
          description: 'The value from the case file, formatted as the form expects it',
        },
      },
    },
    statement: {
      type: 'array',
      required: true,
      description:
        'The statement the claimant pastes into the form: 2-5 paragraphs, flat and factual, ' +
        'covering what was paid for, what happened, what was demanded and when, and what is ' +
        'sought. Written in the claimant\'s first person',
      items: { text: { type: 'string', required: true, description: 'One complete paragraph' } },
    },
    attachments: {
      type: 'array',
      required: true,
      description:
        'The documents to attach, with `held` from what the claimant told us. Unheld items are ' +
        'what they must find before lodging',
      items: {
        label: { type: 'string', required: true, description: 'The document' },
        held: {
          type: 'boolean',
          required: true,
          description: 'True only when the claimant said they have it',
        },
      },
    },
    steps: {
      type: 'array',
      required: true,
      description: 'What the claimant does, in order, in plain imperative sentences',
      items: { text: { type: 'string', required: true, description: 'One step' } },
    },
  },
  actions: {
    packLodged: {
      context: {
        docket: { type: 'string', required: true, description: 'The case this pack belongs to' },
        kind: {
          type: 'string',
          required: true,
          enum: ['chargeback', 'regulator', 'small-claim'],
          description: 'Which lever the claimant just lodged',
        },
        forumName: { type: 'string', required: true, description: 'Where it was lodged' },
      },
    },
  },
  fallbackTemplate: (props) => {
    const text = (row: unknown): string => {
      const entry = (row ?? {}) as Record<string, unknown>;
      return typeof entry.text === 'string' ? entry.text : '';
    };
    const statement = Array.isArray(props.statement) ? props.statement : [];
    const steps = Array.isArray(props.steps) ? props.steps : [];
    const facts = Array.isArray(props.facts) ? props.facts : [];
    return [
      `## ${typeof props.headline === 'string' ? props.headline : 'Escalation'} — ${
        typeof props.forumName === 'string' ? props.forumName : ''
      }`,
      `Case ${typeof props.docket === 'string' ? props.docket : ''}`,
      ...facts.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        return `- **${typeof entry.label === 'string' ? entry.label : ''}:** ${
          typeof entry.value === 'string' ? entry.value : ''
        }`;
      }),
      '### Statement',
      ...statement.map(text),
      '### Steps',
      ...steps.map((row, index) => `${index + 1}. ${text(row)}`),
    ]
      .filter(Boolean)
      .join('\n\n');
  },
};
