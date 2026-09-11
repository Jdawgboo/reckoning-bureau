/**
 * Pure decision half of the process-page system (node-testable — no JSX).
 * Dedicated pages are upgrades; the generic working card is the floor that
 * keeps every unregistered tool visible while it works. Surface renders paint
 * the page themselves, so they never get a process card over their own work.
 */
const DEDICATED_PAGES = new Set(['DeepResearch']);
const NO_PROCESS_PAGE = new Set(['Surface']);

export type ProcessPageKind = 'dedicated' | 'generic' | 'none';

export function processPageKind(componentName: string): ProcessPageKind {
  if (NO_PROCESS_PAGE.has(componentName)) {
    return 'none';
  }
  return DEDICATED_PAGES.has(componentName) ? 'dedicated' : 'generic';
}
