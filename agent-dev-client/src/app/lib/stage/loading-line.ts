/**
 * What the empty stage says while there is nothing renderable. Pure and
 * table-tested like `stage-view.ts`: every waiting state a visitor can be in
 * maps to one line from state the client already holds — no invented phases,
 * no percentages, and no combination that yields silence.
 */
export type LoadingLine =
  | { kind: 'connecting'; text: string }
  | { kind: 'preparing'; text: string }
  | { kind: 'init-failed'; text: string; retry: true }
  | { kind: 'working'; text: string }
  | { kind: 'terminal'; text: string }
  | { kind: 'stuck'; text: string; retry: true };

export interface LoadingLineInput {
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  isReady: boolean;
  initError: boolean;
  runInFlight: boolean;
  narrationLine: string;
  /** A run finished for the live turn but nothing is renderable (stage view is `loading`). */
  settledEmpty: boolean;
  /** Terminal text of the settled turn when the stage could not use it as the page. */
  terminalText: string | null;
}

export interface LoadingLineCopy {
  couldNotConnect: string;
  connecting: string;
  gettingReady: string;
  thinking: string;
  pageLoadFailed: string;
}

export function resolveLoadingLine(input: LoadingLineInput, copy: LoadingLineCopy): LoadingLine {
  if (!input.isReady && input.initError) {
    return { kind: 'init-failed', text: copy.couldNotConnect, retry: true };
  }
  if (input.connectionStatus !== 'connected') {
    return { kind: 'connecting', text: copy.connecting };
  }
  if (!input.isReady) {
    return { kind: 'preparing', text: copy.gettingReady };
  }
  if (input.runInFlight) {
    return { kind: 'working', text: input.narrationLine || copy.thinking };
  }
  if (input.settledEmpty && input.terminalText) {
    return { kind: 'terminal', text: input.terminalText };
  }
  if (input.settledEmpty) {
    return {
      kind: 'stuck',
      text: copy.pageLoadFailed,
      retry: true,
    };
  }
  return { kind: 'preparing', text: copy.gettingReady };
}
