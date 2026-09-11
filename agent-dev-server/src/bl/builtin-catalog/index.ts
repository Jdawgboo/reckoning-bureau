/**
 * Builtin surface catalog — common content components every agent built from this
 * template ships. Files in this directory are authored by template releases; builder
 * agents extend `src/surfaces/index.ts` instead. Client pairing:
 * `agent-dev-client/src/app/lib/a2ui/builtin-catalog/`.
 */

import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { TABLE } from './table.ts';
import { IMAGE } from './image.ts';
import { VIDEO } from './video.ts';
import { FILE_DOWNLOAD } from './file-download.ts';
import { CHART } from './chart.ts';
import { LIST } from './list.ts';
import { STEPS } from './steps.ts';
import { OPTION_GRID } from './option-grid.ts';
import { CHOICE_BOARD } from './choice-board.ts';
import { FORM } from './form.ts';
import { SUMMARY } from './summary.ts';
import { TEXT_BLOCK } from './text-block.ts';

export const BUILTIN_CATALOG_ID = 'agentplace:builtin-v1';

export const BUILTIN_SURFACE_CONTRACTS: Record<string, ComponentContract> = {
  // Content / display
  Table: TABLE,
  Image: IMAGE,
  Video: VIDEO,
  FileDownload: FILE_DOWNLOAD,
  Chart: CHART,
  // NOTE: 'List' shadows the v1-primitive ListView in the client renderer's
  // lookup (agent → builtin → primitives). Nothing emits the primitive today;
  // when generic composition lands (Phase 3) resolution becomes catalogId-aware.
  List: LIST,
  Steps: STEPS,
  // Choose / collect / commit
  OptionGrid: OPTION_GRID,
  ChoiceBoard: CHOICE_BOARD,
  Form: FORM,
  Summary: SUMMARY,
  // Prose
  TextBlock: TEXT_BLOCK,
};
