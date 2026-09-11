import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const VIDEO: ComponentContract = {
  component: 'Video',
  purpose: 'Video card with playback controls and a title.',
  fallbackTemplate: videoFallback,
  props: {
    src: { type: 'string', required: true, description: 'URL of the video' },
    title: { type: 'string', description: 'Title of the card that is shown as large text' },
    poster: { type: 'string', description: 'URL for video poster' },
  },
  publishes: {},
  actions: {},
};

function videoFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const title =
    typeof props.title === 'string' && props.title
      ? formatServerMessage(localization, serverMessages.titledVideoLabel, {
          title: props.title,
        })
      : formatServerMessage(localization, serverMessages.videoLabel);
  const src = typeof props.src === 'string' ? props.src : '';
  return `[${title}](${src})`;
}
