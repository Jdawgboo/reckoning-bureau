export type VoiceIndicatorState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'building';

/**
 * Whether the "run working" indicator stays up after a voice state change.
 * The indicator is raised and lowered ONLY by the server's `voice.run` edges —
 * the server owns run truth. Audio states pass through untouched: speech keeps
 * flowing while a run works, and the visitor talking mid-run (`thinking`) does
 * not finish that run. Only leaving the live session (`idle`, `connecting`)
 * clears it, as the belt to the server signal's braces.
 */
export function runBusyAfterVoiceState(busy: boolean, state: VoiceIndicatorState): boolean {
  if (state === 'idle' || state === 'connecting') {
    return false;
  }
  return busy;
}
