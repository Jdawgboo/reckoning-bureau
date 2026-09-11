/**
 * Registry-assembly of the two surface-contract sets. Shadowing rule: an
 * agent-zone contract with a builtin's component name replaces the builtin —
 * agents that authored a component before the platform shipped a twin keep
 * their own version across template upgrades. SectionStack is instantiated
 * here (not statically) so its section enum spans BOTH contract sets.
 */
import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { SECTION_STACK_NAME, createSectionStackContract } from './section-stack.ts';

export interface SurfaceContractSets {
  agentContracts: Record<string, ComponentContract>;
  builtinContracts: Record<string, ComponentContract>;
}

export function assembleSurfaceContracts(
  agentContracts: Record<string, ComponentContract>,
  builtinContracts: Record<string, ComponentContract>,
): SurfaceContractSets {
  const effectiveBuiltins: Record<string, ComponentContract> = {};
  for (const [name, contract] of Object.entries(builtinContracts)) {
    if (!(name in agentContracts)) {
      effectiveBuiltins[name] = contract;
    }
  }
  if (!(SECTION_STACK_NAME in agentContracts)) {
    effectiveBuiltins[SECTION_STACK_NAME] = createSectionStackContract({
      ...agentContracts,
      ...effectiveBuiltins,
    });
  }
  return { agentContracts, builtinContracts: effectiveBuiltins };
}

/**
 * Whether a contract holds state the visitor put there, and so is worth
 * preserving across a re-render rather than being re-authored.
 *
 * Read from the contract's OWN declaration — `publishes` is where a component
 * states which data-model keys it writes. Inferring this from a prop shape
 * (e.g. "has a `fields` array") silently excludes any future component that
 * takes input differently — a slider, a date picker, a signature pad — and the
 * failure mode is a visitor losing what they entered, with no error anywhere.
 */
export function contractHoldsVisitorState(contract: ComponentContract): boolean {
  return Object.keys(contract.publishes ?? {}).length > 0;
}
