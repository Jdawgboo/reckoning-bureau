import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';

/**
 * The Bureau's front desk — the agent's home screen.
 *
 * Every prop here is fillable from what the model already knows on arrival: no
 * records read, no clock, no external fetch, so the first paint costs one turn.
 */

const LANE_IDS = ['refund-refused', 'deposit-kept', 'never-delivered', 'something-else'] as const;

export const INTAKE_DESK: ComponentContract = {
  component: 'IntakeDesk',
  purpose:
    "The Bureau's front desk: the home screen a visitor meets on arrival. Render it for the " +
    '`[user opened the agent]` turn. It asks what happened and offers the four intake lanes; ' +
    'tapping a lane starts the interrogation for that grievance type.',
  props: {
    headline: {
      type: 'string',
      required: true,
      description:
        'The desk\'s single question to the visitor, e.g. "What happened to you?" — direct, ' +
        'never a marketing headline',
    },
    standfirst: {
      type: 'string',
      required: true,
      description:
        'One supporting line, max ~140 characters: what the Bureau does with what they tell us ' +
        '(takes the details, builds the case file, writes the letters). Plain, procedural, no hype',
    },
    lanes: {
      type: 'array',
      required: true,
      description:
        'The four intake lanes, in this order: refund-refused, deposit-kept, never-delivered, ' +
        'something-else. Always all four — the component draws an icon per id',
      items: {
        id: {
          type: 'string',
          required: true,
          enum: [...LANE_IDS],
          description: 'Which lane this is — fixes the icon and the follow-up questioning',
        },
        label: {
          type: 'string',
          required: true,
          description: 'Short lane name as the visitor reads it, e.g. "Refund refused" (2-4 words)',
        },
        detail: {
          type: 'string',
          required: true,
          description:
            'One concrete example of this grievance in the visitor\'s own words, max ~90 ' +
            'characters, e.g. "They cancelled the order and kept the money."',
        },
      },
    },
    procedure: {
      type: 'array',
      required: true,
      description:
        'Exactly three steps describing how a case moves through the Bureau: intake, then the ' +
        'issued demand, then the escalation clock. Honest about what happens, in this order',
      items: {
        label: {
          type: 'string',
          required: true,
          description: 'Step name in 1-3 words, e.g. "Intake"',
        },
        detail: {
          type: 'string',
          required: true,
          description: 'What the Bureau does at this step, max ~110 characters',
        },
      },
    },
  },
  actions: {
    openLane: {
      context: {
        laneId: {
          type: 'string',
          required: true,
          enum: [...LANE_IDS],
          description: 'The lane the visitor chose',
        },
        label: { type: 'string', required: true, description: 'That lane label, as shown' },
      },
    },
  },
  fallbackTemplate: (props) => {
    const lanes = Array.isArray(props.lanes) ? props.lanes : [];
    const lines = lanes.map((lane) => {
      const entry = (lane ?? {}) as Record<string, unknown>;
      const label = typeof entry.label === 'string' ? entry.label : '';
      const detail = typeof entry.detail === 'string' ? entry.detail : '';
      return `- ${label}${detail ? ` — ${detail}` : ''}`;
    });
    const headline = typeof props.headline === 'string' ? props.headline : '';
    const standfirst = typeof props.standfirst === 'string' ? props.standfirst : '';
    return [`**${headline}**`, standfirst, lines.join('\n')].filter(Boolean).join('\n\n');
  },
};
