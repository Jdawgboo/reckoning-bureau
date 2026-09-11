/**
 * Provider schema-dialect assertions, shared by the platform guard test (fixture
 * contracts) and the agent contracts test (real contracts) so both catalogs are held
 * to the same rules:
 * - Bedrock/Anthropic: no top-level `oneOf`/`allOf`/`anyOf`.
 * - Gemini/Vertex proto: `items` must be a single schema (never a list), and every
 *   `type:'array'` must carry `items`.
 */
import assert from 'node:assert';
import { isRecord } from '../../../util/type-guards.ts';

export function assertGeminiCompatible(node: unknown, path: string, label: string): void {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      assertGeminiCompatible(item, `${path}[${index}]`, label);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if ('items' in node) {
    assert.ok(
      !Array.isArray(node['items']),
      `${label}: tuple-form items (a list) at ${path} — Gemini proto rejects it`,
    );
  }
  if (node['type'] === 'array') {
    assert.ok(isRecord(node['items']), `${label}: array without items at ${path}`);
  }
  for (const [key, value] of Object.entries(node)) {
    assertGeminiCompatible(value, `${path}.${key}`, label);
  }
}

export function assertProviderSafeToolSchema(schema: unknown, label: string): void {
  if (!isRecord(schema)) {
    throw new Error(`${label}: schema is not an object`);
  }
  assert.strictEqual(schema['type'], 'object', `${label}: top level must be type:'object'`);
  assert.strictEqual(schema['oneOf'], undefined, `${label}: no top-level oneOf`);
  assert.strictEqual(schema['allOf'], undefined, `${label}: no top-level allOf`);
  assert.strictEqual(schema['anyOf'], undefined, `${label}: no top-level anyOf`);
  assertGeminiCompatible(schema, 'root', label);
}
