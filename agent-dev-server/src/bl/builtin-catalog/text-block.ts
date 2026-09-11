/**
 * TextBlock — a prose answer as a screen. The screen-only presentation never
 * shows plain assistant text, so free-form/discretionary answers need a
 * surface to live on: this is it. Standalone it is a reading page; inside a
 * SectionStack it is a text band above/below other blocks.
 * Pattern credit: PROD agent m0yiv1jsbo7a (agent-zone original).
 */
import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord } from '../../util/type-guards.ts';

export const TEXT_BLOCK: ComponentContract = {
  component: 'TextBlock',
  purpose:
    'A free-form content screen: markdown prose plus an optional ordered list of building ' +
    'blocks (headings, text, images, buttons) composed in any order and quantity. Use for ' +
    'any answer no structured screen fits — a reading page, an article-style explanation, ' +
    'or a rich answer mixing text, pictures, and next-step buttons. All fields optional.',
  props: {
    title: {
      type: 'string',
      description:
        'Optional heading, styled like every other screen title. Real content naming the ' +
        'subject, never generic filler.',
    },
    subtitle: {
      type: 'string',
      description: 'Optional one-line support text under the heading.',
    },
    body: {
      type: 'string',
      description:
        'Optional answer text shown before the blocks. Markdown supported (bold, lists, ' +
        "links, headings). Written in the agent's own first-person voice.",
    },
    blocks: {
      type: 'array',
      description:
        'Optional ordered content blocks rendered after `body`, in the exact order given. ' +
        'Mix freely: any number of headings, text passages, images, and buttons. ' +
        'Consecutive buttons sit side by side on one row.',
      items: {
        type: {
          type: 'string',
          required: true,
          enum: ['heading', 'text', 'image', 'button'],
          description:
            "Block kind: 'heading' = section heading; 'text' = markdown passage; " +
            "'image' = photo with optional caption; 'button' = tappable action.",
        },
        text: {
          type: 'string',
          description:
            "For 'heading': the heading line. For 'text': the markdown passage. " +
            'Ignored by other kinds.',
        },
        imageUrl: { type: 'string', description: "For 'image': the photo (public https URL)." },
        imageAlt: { type: 'string', description: "For 'image': alt text." },
        caption: {
          type: 'string',
          description: "For 'image': optional caption line under the photo.",
        },
        label: { type: 'string', description: "For 'button': the button label." },
        intent: {
          type: 'string',
          description:
            "For 'button': the message sent when tapped, phrased as the visitor " +
            '(e.g. "I want to book a visit").',
        },
        kind: {
          type: 'string',
          enum: ['primary', 'secondary'],
          description: "For 'button': visual style. Default 'primary'.",
        },
      },
    },
  },
  publishes: {},
  actions: {},
  fallbackTemplate: (props) => {
    const parts: string[] = [];
    if (typeof props.title === 'string' && props.title) {
      parts.push(`## ${props.title}`);
    }
    if (typeof props.subtitle === 'string' && props.subtitle) {
      parts.push(props.subtitle);
    }
    if (typeof props.body === 'string' && props.body) {
      parts.push(props.body);
    }
    const blocks = Array.isArray(props.blocks) ? props.blocks : [];
    for (const raw of blocks) {
      if (!isRecord(raw)) {
        continue;
      }
      const type = typeof raw.type === 'string' ? raw.type : '';
      if (type === 'heading' && typeof raw.text === 'string' && raw.text) {
        parts.push(`### ${raw.text}`);
      } else if (type === 'text' && typeof raw.text === 'string' && raw.text) {
        parts.push(raw.text);
      } else if (type === 'image' && typeof raw.imageUrl === 'string' && raw.imageUrl) {
        const alt = typeof raw.imageAlt === 'string' ? raw.imageAlt : '';
        parts.push(`![${alt}](${raw.imageUrl})`);
      } else if (type === 'button' && typeof raw.label === 'string' && raw.label) {
        parts.push(`→ ${raw.label}`);
      }
    }
    return parts.join('\n\n');
  },
};
