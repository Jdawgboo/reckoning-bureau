/**
 * ensureArrayItems — normalize a JSON Schema so every `type: "array"` node has
 * an `items` sub-schema.
 *
 * Why: Google Vertex / Gemini rejects a tool's `tools` list with
 * `400 INVALID_ARGUMENT ... items: missing field` if *any* declared parameter
 * is `{ "type": "array" }` without `items`. Gemini fails the entire tool list,
 * so a single malformed schema disables *all* tool calls for the turn. Anthropic
 * and OpenAI tolerate arrays without `items`, which is why the problem is
 * provider-specific.
 *
 * Several external MCP tool schemas (notably many Composio Sentry/Linear tools)
 * ship `type: "array"` params with no `items`, sometimes nested inside
 * `anyOf`/`oneOf`/`allOf` or `items`. This walks the schema and injects a
 * permissive `items` wherever one is missing.
 *
 * Injecting `items` is harmless for Anthropic/OpenAI and required by Gemini, so
 * it is applied unconditionally — no per-provider branching. Apply it to MCP
 * tool schemas (untrusted external input) before handing them to the model.
 *
 * The traversal is immutable: the input schema is never mutated.
 */
import type { JSONSchema7, JSONSchema7Definition } from '@ai-sdk/provider';

/**
 * Item schema injected when a `type: "array"` node has no `items`. A concrete
 * OpenAPI-3.0 type is used (rather than an empty `{}`) because Vertex's
 * validator is an OpenAPI-3.0 subset that may reject an item schema with no
 * `type`. Composio array-without-items params (e.g. `triggers`, `project`) are
 * string arrays in practice.
 */
export const DEFAULT_ARRAY_ITEMS: JSONSchema7 = { type: 'string' };

export function ensureArrayItems(schema: JSONSchema7): JSONSchema7 {
  return sanitizeSchema(schema);
}

function sanitizeDefinition(def: JSONSchema7Definition): JSONSchema7Definition {
  if (typeof def === 'boolean') {
    return def;
  }
  return sanitizeSchema(def);
}

function sanitizeSchema(schema: JSONSchema7): JSONSchema7 {
  const result: JSONSchema7 = { ...schema };

  if (result.properties) {
    const properties: Record<string, JSONSchema7Definition> = {};
    for (const [key, value] of Object.entries(result.properties)) {
      properties[key] = sanitizeDefinition(value);
    }
    result.properties = properties;
  }

  if (result.items !== undefined) {
    result.items = Array.isArray(result.items)
      ? result.items.map(sanitizeDefinition)
      : sanitizeDefinition(result.items);
  }

  if (
    result.additionalProperties !== undefined &&
    typeof result.additionalProperties !== 'boolean'
  ) {
    result.additionalProperties = sanitizeDefinition(result.additionalProperties);
  }

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = result[combinator];
    if (branch) {
      result[combinator] = branch.map(sanitizeDefinition);
    }
  }

  if (isArrayType(result) && result.items === undefined) {
    result.items = DEFAULT_ARRAY_ITEMS;
  }

  return result;
}

function isArrayType(schema: JSONSchema7): boolean {
  return schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'));
}
