import { createContext, useContext } from 'react';
import type { ResolvedNode } from '../../../../vendor/agentplace-a2ui/walker.ts';

/** Per-surface API handed to catalog components: pointer reads/writes are
 *  scoped to this surface's data model; submit runs validation + dispatch. */
export interface A2uiSurfaceApi {
  getValue(pointer: string): unknown;
  setValue(pointer: string, value: unknown): void;
  submit(node: ResolvedNode): void;
  /** Dispatch a named action with an already-resolved context (signature
   *  components construct their own events, e.g. tapping a service card).
   *  Same pipeline as submit(): full-doc state sync, then a new turn carrying
   *  the a2uiAction metadata. */
  dispatch(name: string, context: Record<string, unknown>): void;
  /**
   * Push what the visitor has typed to the server WITHOUT submitting anything.
   * Called on field blur, so the agent can reason about a form in progress —
   * asked "is this right?", it can see the answer instead of the empty shape it
   * rendered.
   *
   * Blur, not keystroke: a per-character sync is waste, and `<ui_state>` is
   * re-read on every model call. Sensitive kinds are withheld entirely
   * (`isSensitiveFieldKind`), and the dirty overlay is NOT cleared — only a
   * real submit does that.
   */
  commitValue(): void;
  errorsFor(nodeId: string): string[];
}

export const A2uiSurfaceContext = createContext<A2uiSurfaceApi | null>(null);

export function useSurfaceAction(): A2uiSurfaceApi['dispatch'] | null {
  return useContext(A2uiSurfaceContext)?.dispatch ?? null;
}
