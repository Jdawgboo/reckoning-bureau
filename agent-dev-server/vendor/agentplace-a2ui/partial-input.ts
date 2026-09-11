/**
 * Displacement tests for best-effort-parsed partial tool input: a value counts
 * as complete only when a later sibling has started, because a partial parse
 * gives no signal that the last-seen value has stopped growing. Used by
 * `ComponentContract.composePartial` implementations; never returns a value
 * that may still be mid-write.
 */

export function settledArrayPrefix<T>(items: readonly T[], hasStarted: (item: T) => boolean): T[] {
  let count = 0;
  while (count < items.length - 1 && hasStarted(items[count])) {
    count++;
  }
  return items.slice(0, count);
}

/**
 * A string prop counts as settled once a LATER key has started, so the test is
 * "`key` is not the last key of the partial parse."
 *
 * Relies on `Object.keys` insertion order, which is the parse order for the
 * string keys a contract declares — but integer-like keys ('0', '12') sort
 * ahead of every string key regardless of when they were parsed, so a contract
 * with integer-like prop names would break the last-key test. Contract props
 * are named identifiers; do not reach for this helper on arbitrary maps.
 */
export function settledStringProp(partialProps: Record<string, unknown>, key: string): string {
  const value = partialProps[key];
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  const keys = Object.keys(partialProps);
  return keys[keys.length - 1] === key ? '' : value;
}
