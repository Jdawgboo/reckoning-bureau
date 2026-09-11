import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';

export const IMAGE: ComponentContract = {
  component: 'Image',
  purpose:
    'Shows an image inline. Use ONLY for image formats (PNG/JPG/WEBP/GIF/SVG); for non-image deliverables use FileDownload.',
  fallbackTemplate: imageFallback,
  props: {
    src: {
      type: 'string',
      required: true,
      description:
        '`agent-storage:private/<name>` / `agent-storage:common/<name>` (auto-resolved to a short-lived URL on the client), or a public `https://` URL.',
    },
    alt: { type: 'string', description: 'Image alt attribute' },
  },
  publishes: {},
  actions: {},
};

function imageFallback(props: Record<string, unknown>): string {
  const alt = typeof props.alt === 'string' ? props.alt : '';
  const src = typeof props.src === 'string' ? props.src : '';
  return `![${alt}](${src})`;
}
