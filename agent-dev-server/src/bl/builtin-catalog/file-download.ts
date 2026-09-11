import type {
  ComponentContract,
  FallbackLocalization,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import {
  formatServerMessage,
  serverMessages,
} from '../../services/server-localization-messages.ts';

export const FILE_DOWNLOAD: ComponentContract = {
  component: 'FileDownload',
  purpose:
    'Download card for a produced file (PDF/DOCX/XLSX/PPTX/ZIP/…). Never invent paths — only reference files an actual result reported.',
  fallbackTemplate: fileDownloadFallback,
  props: {
    filename: {
      type: 'string',
      required: true,
      description: 'User-visible filename, e.g. "solar.pptx".',
    },
    path: {
      type: 'string',
      required: true,
      description:
        '`agent-storage:private/<name>` / `agent-storage:common/<name>`, or a public `https://` URL. For a code-executor deliverable use `agent-storage:private/<name>`.',
    },
  },
  publishes: {},
  actions: {},
};

function fileDownloadFallback(
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const filename =
    typeof props.filename === 'string'
      ? props.filename
      : formatServerMessage(localization, serverMessages.genericFile);
  return `**${formatServerMessage(localization, serverMessages.fileReady, { filename })}**`;
}
