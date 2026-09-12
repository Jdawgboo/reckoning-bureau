/**
 * This agent's custom surface components — the client half of the agent's
 * catalog (server half: `agent-dev-server/src/surfaces/`). Each entry maps a
 * `ComponentContract.component` name to its React realization; add one line
 * per screen the builder authors. `SurfaceRenderer` consults this before the
 * platform builtin catalog and the v1 primitives.
 *
 * Empty in the clean template — the builder fills it per use case.
 */
import type { FC } from 'react';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { CaseFile } from './CaseFile.tsx';
import { DemandLetter } from './DemandLetter.tsx';
import { EscalationPack } from './EscalationPack.tsx';
import { IntakeDesk } from './IntakeDesk.tsx';
import { MenuBoard, MenuBoardHeader, MenuBoardItem } from './MenuBoard.tsx';
import { PaymentGate } from './PaymentGate.tsx';

export const AGENT_SURFACE_COMPONENTS: Record<string, FC<A2uiNodeViewProps>> = {
  CaseFile,
  DemandLetter,
  EscalationPack,
  IntakeDesk,
  MenuBoard,
  MenuBoardHeader,
  MenuBoardItem,
  PaymentGate,
};
