/**
 * Minimal JSON Schema validation for record domain fields.
 *
 * Declarations carry standard JSON Schema (the "one schema, four consumers"
 * contract), but Phase-0 enforcement checks only the subset those declarations
 * actually use — deliberately, to avoid a validator dependency in a vendored
 * library. Supported keywords:
 *
 *   root:      `type: 'object'`, `properties`, `required`
 *   property:  `type` ('string' | 'number' | 'integer' | 'boolean' | 'array' |
 *              'object'), `enum`, `format: 'date-time'`
 *
 * Unknown keywords are ignored and extra fields are allowed — the schema is a
 * floor, not a ceiling. H1 may swap in a full validator server-side without
 * changing the declaration shape.
 */

import { isRecord } from '../util/type-guards.ts';

/**
 * Validate a record's domain fields against a declaration's JSON Schema.
 * Returns every violation as one sentence each, or null when valid (or when
 * there is no schema). Reporting all of them at once — and naming the expected type
 * and enum on a missing required field — is what lets a caller correct a
 * record in one attempt instead of one round trip per violation.
 *
 * Messages name the field and the expectation, never the submitted value:
 * they reach the model and, on some paths, an end user's screen.
 */
export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: unknown,
): string | null {
  if (!isRecord(schema)) {
    return null;
  }
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const errors: string[] = [];

  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  for (const field of required) {
    if (typeof field !== 'string') {
      continue;
    }
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null) {
      errors.push(`Field "${field}" is required${describeExpectation(properties[field])}.`);
    }
  }

  // An absent value is already reported by the required pass; a present one is
  // the only thing a property check has to say something about.
  for (const [field, propertySchema] of Object.entries(properties)) {
    const fieldValue = value[field];
    if (fieldValue === undefined || fieldValue === null || !isRecord(propertySchema)) {
      continue;
    }
    const error = checkProperty(field, propertySchema, fieldValue);
    if (error) {
      errors.push(error);
    }
  }
  return errors.length > 0 ? errors.join(' ') : null;
}

/** ` (string, one of: a, b)` — the parenthetical appended to a required-field error. */
function describeExpectation(propertySchema: unknown): string {
  if (!isRecord(propertySchema)) {
    return '';
  }
  const parts: string[] = [];
  if (typeof propertySchema['type'] === 'string') {
    parts.push(propertySchema['type']);
  }
  const allowed = propertySchema['enum'];
  if (Array.isArray(allowed) && allowed.length > 0) {
    parts.push(`one of: ${allowed.map(String).join(', ')}`);
  } else if (propertySchema['format'] === 'date-time') {
    parts.push('ISO date-time');
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function checkProperty(
  field: string,
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (!allowed.some((candidate) => candidate === value)) {
      return `Field "${field}" must be one of: ${allowed.map(String).join(', ')}.`;
    }
    return null;
  }

  const typeError = checkType(field, schema['type'], value);
  if (typeError) {
    return typeError;
  }

  if (schema['format'] === 'date-time') {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `Field "${field}" must be an ISO date-time string.`;
    }
  }
  return null;
}

function checkType(field: string, type: unknown, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `Field "${field}" must be a string.`;
    case 'number':
      return typeof value === 'number' ? null : `Field "${field}" must be a number.`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `Field "${field}" must be an integer.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `Field "${field}" must be a boolean.`;
    case 'array':
      return Array.isArray(value) ? null : `Field "${field}" must be an array.`;
    case 'object':
      return isRecord(value) ? null : `Field "${field}" must be an object.`;
    default:
      return null;
  }
}
