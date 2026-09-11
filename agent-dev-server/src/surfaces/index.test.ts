import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AGENT_CATALOG_ID, AGENT_SURFACE_CONTRACTS } from './index.ts';
import { contractToFlatToolSchema } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import { assertProviderSafeToolSchema } from '../bl/tools/impl/schema-dialect-guards.ts';

describe('agent surface contracts', () => {
  it('declares a catalog id', () => {
    assert.ok(AGENT_CATALOG_ID.length > 0);
  });

  it('every registered contract is provider-safe and carries a purpose', () => {
    for (const [name, contract] of Object.entries(AGENT_SURFACE_CONTRACTS)) {
      assert.ok(contract.purpose.length > 0, `${name} needs a purpose`);
      assertProviderSafeToolSchema(contractToFlatToolSchema(contract), `Render${name}`);
    }
  });

  it('every contract has a React component registered under the same key', () => {
    // A contract without its component renders nothing at all, and the failure
    // only shows up in the browser. Cheapest possible guard: the client
    // registry is a flat literal, so assert each key appears in it.
    const registry = readFileSync(
      new URL('../../../agent-dev-client/src/app/agent/surfaces/index.ts', import.meta.url),
      'utf8',
    );
    for (const name of Object.keys(AGENT_SURFACE_CONTRACTS)) {
      assert.match(
        registry,
        new RegExp(`\\b${name}\\b`),
        `${name} has a contract but no component in the client surface registry`,
      );
    }
  });
});
