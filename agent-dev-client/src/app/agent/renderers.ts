import type { FC } from 'react';

import Image from '@/app/lib/a2ui/builtin-catalog/Image';
import Table from '@/app/lib/a2ui/builtin-catalog/Table';
import Video from '@/app/lib/a2ui/builtin-catalog/Video';
import FileDownload from '@/app/lib/a2ui/builtin-catalog/FileDownload';
import Grep from '@/app/lib/components/process/Grep';

/**
 * Inline tool-card renderers, keyed by a tool's `componentName` and folded
 * into TranscriptPage's INLINE_HOSTS. This is NOT the screens path — screens
 * are ComponentContracts rendered by SurfaceRenderer (see surfaces/index.ts).
 * Entries without a renderer here fall back to the tool's fallback text.
 */
export const componentRenderers: Record<string, FC<any>> = {
  Image,
  Table,
  Video,
  FileDownload,
  Grep,
};
