/**
 * Resolves the stage's error notice — the banner shown when a run failed
 * while a rendered page is on stage. Empty-stage failures never reach this
 * banner: the loading line (empty turn) or the text page (terminal text as
 * the whole page) already own those states.
 */
export interface ErrorNoticeInput {
  viewKind: 'surface' | 'process' | 'text' | 'loading';
  lastRunError: { responseId: string; message: string } | null;
  liveTurn: { responseId: string | undefined; responseText: string } | undefined;
}

export function resolveErrorNotice(input: ErrorNoticeInput): string | null {
  if (!input.lastRunError) {
    return null;
  }
  if (input.viewKind === 'text' || input.viewKind === 'loading') {
    return null;
  }
  if (input.liveTurn?.responseId !== input.lastRunError.responseId) {
    return null;
  }
  return input.liveTurn.responseText || input.lastRunError.message;
}
