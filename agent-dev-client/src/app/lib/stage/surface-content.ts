import { surfaceIsStructurallyPopulated } from '../../../../vendor/agentplace-a2ui/walker.ts';
import type { A2uiSurfaceRecord } from '../state/A2uiSurfaceStore.ts';

/**
 * Whether this surface has stage-preservable structural content right now.
 *
 * Not a component count. A progressive render's first frame is a single node —
 * the stack root with no sections settled yet — so counting components calls an
 * empty container "content" and hands it the stage, blanking whatever the
 * visitor was reading a beat before it fills in. This is not a DOM-paint test:
 * a structurally populated leaf component can still choose to render `null`.
 *
 * The distinction is the root's own `children` field, read from the raw node
 * because the resolved tree cannot express it: an empty array means a container
 * still waiting for sections, while an absent one means a leaf that IS the
 * screen (a single-component render like `Table` is its own root).
 */
export function surfaceRendersSomething(surface: A2uiSurfaceRecord): boolean {
  return surfaceIsStructurallyPopulated(surface);
}
