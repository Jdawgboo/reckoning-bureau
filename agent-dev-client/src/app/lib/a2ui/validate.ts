/**
 * Per-field check runner for signature form components: reuses the
 * vendored `evaluateChecks` — the same machinery SurfaceRenderer's
 * `submit()` runs — instead of duplicating validation logic. Only the
 * per-field grouping is new, and it lives here in the signature zone, not
 * in blocks.
 */
import { evaluateChecks } from '../../../../vendor/agentplace-a2ui/functions.ts';
import { str } from './props.ts';

export interface CheckableField {
  id: string;
  label: string;
  /** Standard A2UI `checks` array, unresolved (args carry `{path}` refs). */
  checks?: unknown;
  /** Contract sugar: `required: true` ⇒ a synthesized `required` check. */
  required?: boolean;
}

/** Build the effective checks for one field: explicit `checks` plus the
 *  synthesized `required` check when the contract's `required` flag is set. */
function effectiveChecks(field: CheckableField, pointer: string): unknown[] {
  const checks = Array.isArray(field.checks) ? [...field.checks] : [];
  if (field.required === true) {
    checks.push({
      call: 'required',
      args: { value: { path: pointer } },
      message: `${str(field.label) || field.id} is required`,
    });
  }
  return checks;
}

/**
 * Evaluate every field's checks against the surface-scoped data model.
 * Returns error messages keyed by field id; empty object = all green.
 */
export function evaluateFieldChecks(
  fields: CheckableField[],
  pointerFor: (fieldId: string) => string,
  dataModel: unknown,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const field of fields) {
    const result = evaluateChecks(effectiveChecks(field, pointerFor(field.id)), dataModel);
    if (!result.ok) {
      errors[field.id] = result.messages;
    }
  }
  return errors;
}
