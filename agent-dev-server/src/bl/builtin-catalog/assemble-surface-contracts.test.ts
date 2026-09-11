import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  assembleSurfaceContracts,
  contractHoldsVisitorState,
} from './assemble-surface-contracts.ts';
import { BUILTIN_SURFACE_CONTRACTS } from './index.ts';
import { SECTION_STACK_NAME } from './section-stack.ts';
import type { ComponentContract } from '../../../vendor/agentplace-a2ui/contract-schema.ts';

const AGENT_TWIN: ComponentContract = {
  component: 'Table',
  purpose: 'Agent-authored twin.',
  props: {},
  publishes: {},
  actions: {},
};

describe('assembleSurfaceContracts', () => {
  it('instantiates SectionStack over agent + builtin contracts', () => {
    const sets = assembleSurfaceContracts({}, BUILTIN_SURFACE_CONTRACTS);
    const stackContract = sets.builtinContracts[SECTION_STACK_NAME];
    assert.ok(stackContract);
    assert.ok(stackContract.compose);
    assert.ok(sets.builtinContracts.Table);
  });

  it('agent-zone contract name shadows the builtin twin', () => {
    const sets = assembleSurfaceContracts({ Table: AGENT_TWIN }, BUILTIN_SURFACE_CONTRACTS);
    assert.strictEqual(sets.builtinContracts.Table, undefined);
    assert.strictEqual(sets.agentContracts.Table.purpose, 'Agent-authored twin.');
  });

  it('agent-zone SectionStack suppresses the platform instantiation', () => {
    const agentStack: ComponentContract = {
      component: SECTION_STACK_NAME,
      purpose: 'Agent-authored stack.',
      props: {},
      publishes: {},
      actions: {},
    };
    const sets = assembleSurfaceContracts(
      { [SECTION_STACK_NAME]: agentStack },
      BUILTIN_SURFACE_CONTRACTS,
    );
    assert.strictEqual(sets.builtinContracts[SECTION_STACK_NAME], undefined);
  });

  it('the platform stack can compose agent-zone screens (enum spans both sets)', () => {
    const agentScreen: ComponentContract = {
      component: 'Menu',
      purpose: 'Agent screen.',
      props: {},
      publishes: {},
      actions: {},
    };
    const sets = assembleSurfaceContracts({ Menu: agentScreen }, BUILTIN_SURFACE_CONTRACTS);
    const problems = sets.builtinContracts[SECTION_STACK_NAME]?.validateProps?.({
      sections: [{ component: 'Menu', props: {} }],
    });
    assert.deepStrictEqual(problems, []);
  });
});

describe('contractHoldsVisitorState', () => {
  it('reads the contract declaration, not a prop shape', () => {
    const interactive: ComponentContract = {
      component: 'Slider',
      purpose: 'A component that takes input without any fields array.',
      props: { min: { type: 'number', description: 'Min' } },
      publishes: { '/booking/guests': { valueType: 'number' } },
      actions: {},
    };
    const displayOnly: ComponentContract = {
      component: 'Prose',
      purpose: 'Display only.',
      props: { markdown: { type: 'string', description: 'Body' } },
      publishes: {},
      actions: {},
    };
    assert.strictEqual(contractHoldsVisitorState(interactive), true);
    assert.strictEqual(contractHoldsVisitorState(displayOnly), false);
  });
});
