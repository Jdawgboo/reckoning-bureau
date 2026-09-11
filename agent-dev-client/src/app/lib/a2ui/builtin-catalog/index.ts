/**
 * Builtin surface registry — thin map only. Each component file owns its
 * adapter; adding a component = one file + one line here. Must stay
 * index-paired with the server's contract catalog:
 * `agent-dev-server/src/bl/builtin-catalog/index.ts`.
 */
import type { FC } from 'react';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { TableSurface } from './Table.tsx';
import { ImageSurface } from './Image.tsx';
import { VideoSurface } from './Video.tsx';
import { FileDownloadSurface } from './FileDownload.tsx';
import { ChartSurface } from './Chart.tsx';
import { ListSurface } from './List.tsx';
import { StepsSurface } from './Steps.tsx';
import { OptionGridSurface } from './OptionGrid.tsx';
import { ChoiceBoardSurface } from './ChoiceBoard.tsx';
import { FormSurface } from './Form.tsx';
import { SummarySurface } from './Summary.tsx';
import { TextBlockSurface } from './TextBlock.tsx';

export const BUILTIN_SURFACE_COMPONENTS: Record<string, FC<A2uiNodeViewProps>> = {
  // Content / display
  Table: TableSurface,
  Image: ImageSurface,
  Video: VideoSurface,
  FileDownload: FileDownloadSurface,
  Chart: ChartSurface,
  // NOTE: 'List' shadows the v1-primitive ListView (renderer lookup: agent →
  // builtin → primitives). Nothing emits the primitive today; when generic
  // composition lands (Phase 3) resolution becomes catalogId-aware.
  List: ListSurface,
  Steps: StepsSurface,
  // Choose / collect / commit
  OptionGrid: OptionGridSurface,
  ChoiceBoard: ChoiceBoardSurface,
  Form: FormSurface,
  Summary: SummarySurface,
  // Prose
  TextBlock: TextBlockSurface,
};
