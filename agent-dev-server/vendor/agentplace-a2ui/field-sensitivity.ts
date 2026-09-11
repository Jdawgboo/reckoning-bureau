/**
 * Which input kinds must never leave the browser.
 *
 * Typed values sync to the server so the agent can reason about a form the
 * visitor is filling — but some values must not travel at all. This list is the
 * enforcement point; it is not a prompt rule, because a prompt rule is a
 * request and this is a guarantee.
 *
 * Shared (not server-only) because the decision is applied **client-side**, at
 * the moment the document is assembled for sync — the value never leaves the
 * browser rather than being scrubbed after arrival.
 *
 * **A block-list, deliberately** (Eugene, 2026-07-27), rather than an allow-list
 * of the kinds `Form` declares today. The cost of that choice: a field kind
 * added later syncs unless someone adds it here. If you are adding an input kind
 * that carries anything a visitor would not read aloud in a café — an id number,
 * a date of birth, a security answer — add it below.
 */

/** Input kinds withheld from state sync. */
export const SENSITIVE_FIELD_KINDS: ReadonlySet<string> = new Set([
  'password',
  'payment',
  'card',
  'cardNumber',
  'cvc',
  'securityCode',
]);

export function isSensitiveFieldKind(kind: unknown): boolean {
  return typeof kind === 'string' && SENSITIVE_FIELD_KINDS.has(kind);
}
