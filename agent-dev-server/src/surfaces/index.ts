/**
 * This agent's surface catalog: one contract file per screen, aggregated
 * here. The platform derives the `Render<Component>` tool, schema,
 * validation, and fallback from each contract; each entry pairs with one
 * React component in `agent-dev-client/src/app/agent/surfaces/`.
 * `PropSpec.description` and `purpose` are model-facing — do not paraphrase.
 *
 * Empty in the clean template — the builder fills it per use case.
 */

import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import { CASE_FILE } from './case-file.ts';
import { DEMAND_LETTER } from './demand-letter.ts';
import { DEPOSIT_INTAKE } from './deposit-intake.ts';
import { ESCALATION_PACK } from './escalation-pack.ts';
import { INTAKE_DESK } from './intake-desk.ts';
import { MENU_BOARD } from './menu-board.ts';
import { OPPOSITION_HEARING } from './opposition-hearing.ts';
import { PAYMENT_GATE } from './payment-gate.ts';

export const AGENT_CATALOG_ID = 'agent:custom-v1';

export const AGENT_SURFACE_CONTRACTS: Record<string, ComponentContract> = {
  [INTAKE_DESK.component]: INTAKE_DESK,
  [CASE_FILE.component]: CASE_FILE,
  [DEPOSIT_INTAKE.component]: DEPOSIT_INTAKE,
  [DEMAND_LETTER.component]: DEMAND_LETTER,
  [ESCALATION_PACK.component]: ESCALATION_PACK,
  [MENU_BOARD.component]: MENU_BOARD,
  [PAYMENT_GATE.component]: PAYMENT_GATE,
  [OPPOSITION_HEARING.component]: OPPOSITION_HEARING,
};
