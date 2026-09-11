/**
 * Page-load-scoped fact for the voice activation wire: has voice already been
 * opened once on this page? The first open of a page load claims the greeting
 * (`greet: true` on `voice.activate`); every later open on the same page stays
 * silent, so toggling voice off and on never re-greets. Module state is the
 * scope on purpose — it lives exactly as long as the page.
 */
let voiceOpenedThisPageLoad = false;

export function claimFirstVoiceOpen(): boolean {
  const first = !voiceOpenedThisPageLoad;
  voiceOpenedThisPageLoad = true;
  return first;
}

export function resetVoiceGreetingLedgerForTests(): void {
  voiceOpenedThisPageLoad = false;
}
