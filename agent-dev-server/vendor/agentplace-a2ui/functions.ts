/**
 * The v1 allow-listed catalog functions — no expression eval, only these
 * run. `formatString` is used by the walker in value positions;
 * `required`/`regexCheck`/`email` are check evaluators wired to input
 * validation.
 */

import { resolvePointer } from './data-model.ts';

export type PointerLookup = (pointer: string) => unknown;

export function formatString(template: string, lookup: PointerLookup): string {
  return template.replace(/\$\{([^}]+)\}/g, (_m, pointer: string) => {
    const value = lookup(pointer);
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  });
}

export function required(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function regexCheck(value: unknown, pattern: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }
  return re.test(String(value ?? ''));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value: unknown): boolean {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

export interface CheckResult {
  ok: boolean;
  messages: string[];
}

/** Evaluate an input's `checks` array (walker passes it through unresolved).
 *  Unknown calls and malformed entries are ignored — fail-open. */
export function evaluateChecks(checks: unknown, dataModel: unknown): CheckResult {
  if (!Array.isArray(checks)) {
    return { ok: true, messages: [] };
  }
  const messages: string[] = [];
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) {
      continue;
    }
    const c = check as Record<string, unknown>;
    if (typeof c.call !== 'string') {
      continue;
    }
    const args = (typeof c.args === 'object' && c.args !== null ? c.args : {}) as Record<
      string,
      unknown
    >;
    const rawValue = args.value;
    const resolved =
      typeof rawValue === 'object' &&
      rawValue !== null &&
      typeof (rawValue as Record<string, unknown>).path === 'string'
        ? resolvePointer(dataModel, (rawValue as Record<string, unknown>).path as string)
        : rawValue;

    let passed: boolean | null = null;
    if (c.call === 'required') {
      passed = required(resolved);
    } else if (c.call === 'regex') {
      passed = typeof args.pattern === 'string' ? regexCheck(resolved, args.pattern) : null;
    } else if (c.call === 'email') {
      passed = email(resolved);
    }
    if (passed === false) {
      messages.push(typeof c.message === 'string' ? c.message : 'Invalid value');
    }
  }
  return { ok: messages.length === 0, messages };
}
