/**
 * Turn ↔ URL fragment mapping and the browser-history decision matrix for
 * the stage. The fragment is the 1-based ordinal of the SHOWN turn (`#3`);
 * the home turn (index 0) keeps a fragment-free URL. Pure and effect-free —
 * StageShell owns the History API calls.
 */

const FRAGMENT_RE = /^#([1-9][0-9]*)$/;

export function parseTurnFragment(hash: string): number | null {
  const match = FRAGMENT_RE.exec(hash);
  if (!match) {
    return null;
  }
  return Number(match[1]) - 1;
}

export function formatTurnFragment(index: number): string {
  return index <= 0 ? '' : `#${index + 1}`;
}

export type HistoryAction = 'push' | 'replace' | 'none';

/** Push/replace rules that keep Back AND Forward correct: a change caused by
 *  popstate must never push (it would truncate the forward stack), the first
 *  sync of a load aligns the current entry, and a clamped stale index
 *  rewrites in place. */
export function resolveHistoryAction(input: {
  urlIndex: number | undefined;
  shownIndex: number;
  fromPopstate: boolean;
}): HistoryAction {
  if (input.urlIndex === input.shownIndex) {
    return 'none';
  }
  if (input.urlIndex === undefined || input.fromPopstate) {
    return 'replace';
  }
  return 'push';
}
