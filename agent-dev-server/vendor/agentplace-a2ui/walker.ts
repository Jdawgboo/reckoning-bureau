/**
 * Target-agnostic A2UI tree walker: turns a surface's flat adjacency list plus
 * its data model into a resolved render tree. Pure and emitter-independent —
 * the React layer (and later channel emitters) map ResolvedNode to native
 * widgets. Read path only: `checks` and `action` props pass through
 * untouched.
 */

import type { A2uiComponentNode } from './types.ts';
import { resolvePointer } from './data-model.ts';
import { formatString } from './functions.ts';
import { isCatalogComponent } from './catalog-schema.ts';
import { isRecord } from './type-guards.ts';

export interface ResolvedNode {
  id: string;
  component: string;
  known: boolean;
  props: Record<string, unknown>;
  children: ResolvedNode[];
  danglingChildIds: string[];
  /** Props bound via `{path}` — surfaced so callers can write back through them. */
  bindings: Record<string, string>;
}

const STRUCTURAL_KEYS = new Set(['id', 'component', 'children', 'child']);
/** Props never dynamic-resolved: consumers evaluate them lazily. */
const PASSTHROUGH_KEYS = new Set(['checks', 'action']);
const MAX_VALUE_DEPTH = 4;
const MAX_TREE_DEPTH = 50;

export function resolveSurface(
  surface: { components: ReadonlyMap<string, A2uiComponentNode> },
  dataModel: unknown,
): ResolvedNode | null {
  const root = surface.components.get('root');
  if (!root) {
    return null;
  }
  return resolveNode(root, surface.components, dataModel, new Set());
}

/**
 * Whether a surface has a resolved root or child worth preserving on screen.
 * A root with a `children` array is structural: it stays empty until at least
 * one referenced child exists. A root without that array is itself the screen.
 */
export function surfaceIsStructurallyPopulated(
  surface: { components: ReadonlyMap<string, A2uiComponentNode> } | undefined,
): boolean {
  const components = surface?.components;
  if (!components) {
    return false;
  }
  const root = components.get('root');
  if (!root) {
    return false;
  }
  if (!Array.isArray(root.children)) {
    return true;
  }
  return root.children.some((childId) => typeof childId === 'string' && components.has(childId));
}

function resolveNode(
  node: A2uiComponentNode,
  components: ReadonlyMap<string, A2uiComponentNode>,
  dataModel: unknown,
  ancestry: ReadonlySet<string>,
): ResolvedNode {
  const childIds = node.children ?? (node.child ? [node.child] : []);
  const nextAncestry = new Set(ancestry).add(node.id);

  const children: ResolvedNode[] = [];
  const danglingChildIds: string[] = [];
  for (const childId of childIds) {
    if (typeof childId !== 'string') {
      continue;
    }
    const child = components.get(childId);
    // Cycles and depth blowups degrade to dangling refs (skeletons), not hangs.
    if (!child || ancestry.has(childId) || nextAncestry.size > MAX_TREE_DEPTH) {
      danglingChildIds.push(childId);
      continue;
    }
    children.push(resolveNode(child, components, dataModel, nextAncestry));
  }

  const props: Record<string, unknown> = {};
  const bindings: Record<string, string> = {};
  for (const [key, raw] of Object.entries(node)) {
    if (STRUCTURAL_KEYS.has(key)) {
      continue;
    }
    if (PASSTHROUGH_KEYS.has(key)) {
      props[key] = raw;
      continue;
    }
    if (isRecord(raw) && typeof raw['path'] === 'string' && Object.keys(raw).length === 1) {
      bindings[key] = raw['path'];
    }
    props[key] = resolveValue(raw, dataModel, MAX_VALUE_DEPTH);
  }

  return {
    id: node.id,
    component: node.component,
    known: isCatalogComponent(node.component),
    props,
    children,
    danglingChildIds,
    bindings,
  };
}

function resolveValue(value: unknown, dataModel: unknown, depth: number): unknown {
  if (depth <= 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, dataModel, depth - 1));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value['path'] === 'string' && Object.keys(value).length === 1) {
    return resolvePointer(dataModel, value['path']);
  }
  if (typeof value['call'] === 'string') {
    return evaluateCall(value['call'], value['args'], dataModel);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    resolved[key] = resolveValue(inner, dataModel, depth - 1);
  }
  return resolved;
}

/** Value-position calls: only formatString in v1; anything else → undefined. */
function evaluateCall(name: string, args: unknown, dataModel: unknown): unknown {
  if (name === 'formatString' && isRecord(args) && typeof args['value'] === 'string') {
    return formatString(args['value'], (pointer) => resolvePointer(dataModel, pointer));
  }
  return undefined;
}
