import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * The case file itself — the Bureau's central document.
 *
 * Two states, one contract. Without `docket` it is an UNFILED draft: the
 * visitor reads back what we have and presses the stamp, and the component
 * commits it to the registry (`cases.open`), which mints the docket number
 * server-side. With `docket` it renders the registry's own live copy, so the
 * file the visitor sees is the file the office holds.
 */

export const CASE_FILE: ComponentContract = {
  component: 'CaseFile',
  purpose:
    'The assembled case file. Render it WITHOUT `docket` once you have the counterparty, what ' +
    'happened, what they want, and any dates or evidence they mentioned — the visitor then ' +
    'stamps it and our registry mints the docket number. Render it WITH `docket` to show an ' +
    'already-opened file (status, docket entries, next action) — then the stored copy is ' +
    'authoritative and the other props are ignored. Never invent a docket number yourself.',
  props: {
    docket: {
      type: 'string',
      description:
        'An existing docket number such as "RB-2025-0007" — ONLY one our registry already ' +
        'returned. Omit for a file that has not been opened yet',
    },
    counterpartyName: {
      type: 'string',
      required: true,
      description: 'Who the grievance is against, exactly as the visitor named them',
    },
    counterpartyKind: {
      type: 'string',
      description: 'What they are in one or two words, e.g. "Airline", "Landlord", "Marketplace"',
    },
    category: {
      type: 'string',
      required: true,
      enum: ['refund-refused', 'deposit-kept', 'never-delivered', 'something-else'],
      description: 'The intake lane this grievance belongs to',
    },
    summary: {
      type: 'string',
      required: true,
      description:
        'The grievance in 2-4 flat, factual sentences, written as the office would record it — ' +
        'no adjectives, no speculation, only what the visitor stated',
    },
    remedySought: {
      type: 'string',
      required: true,
      description: 'What the visitor wants to happen, concretely, e.g. "Full refund of £480"',
    },
    amountValue: {
      type: 'number',
      description: 'The disputed amount as a number, when one is known. Never estimate it',
    },
    currency: {
      type: 'string',
      description: 'ISO currency code for `amountValue`, e.g. "GBP". Required whenever an amount is given',
    },
    claimantName: { type: 'string', description: "The visitor's name, if they have given it" },
    claimantContact: {
      type: 'string',
      description: 'Email or phone the visitor gave for correspondence, if any',
    },
    chronology: {
      type: 'array',
      required: true,
      description:
        'What happened, oldest first, only events the visitor actually reported. Empty array ' +
        'when no dates have been established yet',
      items: {
        date: {
          type: 'string',
          description: 'The date as the visitor gave it, e.g. "3 Aug 2025" or "early July"',
        },
        event: {
          type: 'string',
          required: true,
          description: 'One factual line: what happened, in the office\'s flat register',
        },
      },
    },
    evidence: {
      type: 'array',
      required: true,
      description:
        'The proof schedule: every document that matters for this grievance, with `held` set ' +
        'from what the visitor told us. Include items they do NOT have — an unchecked line is ' +
        'an instruction to go and find it',
      items: {
        label: {
          type: 'string',
          required: true,
          description: 'The document, e.g. "Booking confirmation email"',
        },
        held: {
          type: 'boolean',
          required: true,
          description: 'True only when the visitor said they have it. Never assume',
        },
        detail: {
          type: 'string',
          description: 'One short line: what it proves, or where to find it if they lack it',
        },
      },
    },
  },
  actions: {
    caseFiled: {
      context: {
        docket: { type: 'string', required: true, description: 'The docket number just minted' },
        counterpartyName: {
          type: 'string',
          required: true,
          description: 'The counterparty on that file',
        },
      },
    },
    faceOpposition: {
      context: {
        docket: {
          type: 'string',
          required: true,
          description: 'The registered docket whose claimant chose the evidence-only hearing',
        },
        hearingPacket: {
          type: 'string',
          required: true,
          description:
            'The CaseFile-generated packet containing only the chronology and exhibits recorded as held. This is the complete permitted record for respondent counsel; never supplement it with the case summary, assessment, strength score, settlement data, or red-team notes.',
        },
      },
    },
  },
  fallbackTemplate: (props) => {
    const docket = typeof props.docket === 'string' ? props.docket : 'UNFILED';
    const counterparty = typeof props.counterpartyName === 'string' ? props.counterpartyName : '';
    const summary = typeof props.summary === 'string' ? props.summary : '';
    const remedy = typeof props.remedySought === 'string' ? props.remedySought : '';
    const chronology = Array.isArray(props.chronology) ? props.chronology : [];
    const evidence = Array.isArray(props.evidence) ? props.evidence : [];
    const lines = [
      `## Case file ${docket} — ${counterparty}`,
      summary,
      remedy ? `**Remedy sought:** ${remedy}` : '',
      chronology.length > 0 ? '### Chronology' : '',
      ...chronology.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        const date = typeof entry.date === 'string' ? entry.date : '';
        const event = typeof entry.event === 'string' ? entry.event : '';
        return `- ${date ? `${date} — ` : ''}${event}`;
      }),
      evidence.length > 0 ? '### Evidence' : '',
      ...evidence.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        const label = typeof entry.label === 'string' ? entry.label : '';
        return `- [${entry.held === true ? 'x' : ' '}] ${label}`;
      }),
    ];
    return lines.filter(Boolean).join('\n\n');
  },
};
