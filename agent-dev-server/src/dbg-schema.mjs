import { SIGNATURE_CONTRACTS } from '../vendor/agentplace-a2ui/signature-catalog.ts';
import { contractToFlatToolSchema } from '../vendor/agentplace-a2ui/contract-schema.ts';

for (const [name, contract] of Object.entries(SIGNATURE_CONTRACTS)) {
  const schema = contractToFlatToolSchema(contract);
  console.log('=== ' + name + ' ===');
  console.log(JSON.stringify(schema, null, 2));
}
