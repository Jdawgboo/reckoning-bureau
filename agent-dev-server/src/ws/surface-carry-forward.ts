/**
 * What on a live screen is worth carrying into the next render of that screen.
 *
 * Answering a question is a render like any other, so without this the answer's
 * composition replaces the screen and a form the visitor was filling goes with
 * it. The server decides rather than the model: re-including the form every
 * turn is exactly the instruction a model forgets while concentrating on the
 * answer, and forgetting silently destroys what someone typed.
 *
 * Kept standalone (not on `AgentSession`) so it is node-loadable and testable
 * without the session's runtime import graph.
 */

import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import type { A2uiComponentNode } from '../../vendor/agentplace-a2ui/types.ts';
import { surfaceIsStructurallyPopulated } from '../../vendor/agentplace-a2ui/walker.ts';
import type { SurfaceSnapshot } from '../types.ts';
import { isRecord } from '../util/type-guards.ts';

/** The composed root of a stacked surface. Single-component surfaces have no
 *  section list, so nothing is carried — reusing their `surfaceId` is an
 *  explicit "this screen is now just this". */
const ROOT_NODE_ID = 'root';

/**
 * Every section currently composed on `surface`, in screen order, shaped as
 * `RenderSectionStack` sections (`{ component, props }`) so the tool layer can
 * filter them and append the survivors to the next call's `sections`.
 */
export function sectionsOnScreen(
  surface: ReducedSurface | undefined,
): Array<{ component: string; props: Record<string, unknown> }> {
  const root = surface?.components.get(ROOT_NODE_ID);
  if (!surface || !root || !Array.isArray(root.children)) {
    return [];
  }
  const sections: Array<{ component: string; props: Record<string, unknown> }> = [];
  for (const childId of root.children) {
    if (typeof childId !== 'string') {
      continue;
    }
    const node = surface.components.get(childId);
    if (!node) {
      continue; // a dangling id — a skeleton, nothing to preserve
    }
    sections.push({ component: node.component, props: nodeToProps(node) });
  }
  return sections;
}

/**
 * Everything visible on `surface`, in screen order — like `sectionsOnScreen`,
 * plus the shape that function deliberately ignores: a default render's single
 * root node with no `children` (what `buildSurfaceEvents` emits without a
 * compose hook — every plain RenderTable/RenderChart/RenderCard screen). Carry-
 * forward keeps skipping that shape on purpose (a lone root is replaced
 * wholesale, never carried); a reader describing the screen must not.
 */
export function visibleSections(
  surface: ReducedSurface | undefined,
): Array<{ component: string; props: Record<string, unknown> }> {
  const sections = sectionsOnScreen(surface);
  if (sections.length > 0) {
    return sections;
  }
  const root = surface?.components.get(ROOT_NODE_ID);
  if (!root || Array.isArray(root.children)) {
    return sections;
  }
  return [{ component: root.component, props: nodeToProps(root) }];
}

export function snapshotSurface(surface: ReducedSurface | undefined): SurfaceSnapshot {
  return {
    isPopulated: surfaceIsStructurallyPopulated(surface),
    sections: sectionsOnScreen(surface),
  };
}

/** A composed node carries its props flattened alongside `id`/`component`;
 *  a section wants them back under `props`. */
function nodeToProps(node: A2uiComponentNode): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (!isRecord(node)) {
    return props;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'id' || key === 'component' || key === 'children') {
      continue;
    }
    props[key] = value;
  }
  return props;
}
