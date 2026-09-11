import type {
  BrowserVoiceActivateEvent,
  BrowserVoiceScreenEvent,
  BrowserVoiceScreenSelection,
} from '../../../../../shared/ws-protocol.ts';

/** Keeps attachment-local screen selection ordered across activation and live updates. */
export class VoiceScreenSelectionTracker {
  #selection: BrowserVoiceScreenSelection;
  #activationSent = false;

  constructor(selection: BrowserVoiceScreenSelection) {
    this.#selection = selection;
  }

  activate(): BrowserVoiceActivateEvent {
    this.#activationSent = true;
    return { type: 'voice.activate', screen: this.#selection };
  }

  update(selection: BrowserVoiceScreenSelection): BrowserVoiceScreenEvent | null {
    if (sameSelection(this.#selection, selection)) {
      return null;
    }
    this.#selection = selection;
    return this.#activationSent ? { type: 'voice.screen', screen: selection } : null;
  }
}

function sameSelection(
  left: BrowserVoiceScreenSelection,
  right: BrowserVoiceScreenSelection,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'surface' && right.kind === 'surface') {
    return left.surfaceId === right.surfaceId;
  }
  return left.kind === 'text' && right.kind === 'text' && left.text === right.text;
}
