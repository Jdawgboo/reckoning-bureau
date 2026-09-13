import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * The claimant-facing shell for a bounded evidence challenge. Its hearing packet
 * is intentionally opaque to the UI: it is forwarded only through declared
 * actions so the main agent can hand the same narrow packet to its locked-down
 * counsel subagent on every exchange.
 */
export const OPPOSITION_HEARING: ComponentContract = {
  component: 'OppositionHearing',
  purpose:
    'A controlled respondent-side evidence hearing. Render it only after a claimant presses Face the Opposition on a registered CaseFile and the respondent-counsel subagent has produced one grounded question. It may receive only that file’s chronology and held-exhibit packet — never an assessment, strength score, settlement information, or red-team notes.',
  props: {
    docket: {
      type: 'string',
      required: true,
      description: 'The existing case docket that the hearing belongs to',
    },
    hearingPacket: {
      type: 'string',
      required: true,
      description:
        'The immutable evidence-only packet returned by the CaseFile action: chronology and held exhibits only. Preserve it exactly between exchanges; never add any case summary, analysis, scoring, settlement information, or red-team material.',
    },
    exchange: {
      type: 'number',
      required: true,
      description: 'Number of claimant answers already recorded in this hearing, from 0 through 10',
    },
    question: {
      type: 'string',
      description: 'One current direct question from respondent counsel. Omit only when the hearing is complete or stopped.',
    },
    transcript: {
      type: 'string',
      required: true,
      description:
        'The compact hearing-only transcript of prior counsel questions and claimant answers. Preserve it exactly and never mix in other case information.',
    },
    state: {
      type: 'string',
      required: true,
      enum: ['questioning', 'complete', 'stopped'],
      description: 'questioning while one answer is requested; complete after the review note; stopped when the claimant said stop',
    },
    note: {
      type: 'string',
      description: 'The final three-answer review note, or the immediate stopped notice. Never a prediction of outcome.',
    },
  },
  actions: {
    hearingAnswer: {
      context: {
        docket: { type: 'string', required: true, description: 'The existing docket for this hearing' },
        hearingPacket: {
          type: 'string',
          required: true,
          description: 'The unchanged evidence-only hearing packet from the CaseFile action',
        },
        exchange: {
          type: 'number',
          required: true,
          description: 'The number of answers already recorded before this response',
        },
        question: {
          type: 'string',
          required: true,
          description: 'The respondent counsel question the claimant is answering',
        },
        transcript: {
          type: 'string',
          required: true,
          description: 'The complete prior hearing-only question-and-answer transcript',
        },
        answer: {
          type: 'string',
          required: true,
          description: 'The claimant’s current answer. It is not evidence by itself.',
        },
        endRequested: {
          type: 'boolean',
          required: true,
          description: 'True when this answer completes the tenth exchange or the claimant selected End the hearing',
        },
        stopRequested: {
          type: 'boolean',
          required: true,
          description: 'True when the claimant said stop; end immediately with no review',
        },
      },
    },
  },
  fallbackTemplate: (props) => {
    const state = typeof props.state === 'string' ? props.state : 'questioning';
    const question = typeof props.question === 'string' ? props.question : '';
    const note = typeof props.note === 'string' ? props.note : '';
    if (state === 'questioning') {
      return `## Face the Opposition\n\n${question}`;
    }
    return `## Opposition hearing ${state === 'stopped' ? 'stopped' : 'review'}\n\n${note}`;
  },
};
