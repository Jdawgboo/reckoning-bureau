/**
 * Re-export shim. The content reducer moved to `kernel/utils/content-reducer.ts`
 * because it is shared delta-reduction infrastructure (used by both UI rendering
 * and server-side content capture), not a UI-only concern, and `kernel/utils`
 * is vendored to both browser and server targets. UI consumers keep importing
 * from here unchanged.
 */
export * from '../kernel/utils/content-reducer.ts';
