/**
 * Reading and resolving A2UI actions, shared because a browser click and a press-by-name
 * must agree. Pointer reads are injected: the two sides hold their state differently.
 */

import type { ResolvedNode } from './walker.ts';
import { isRecord } from './type-guards.ts';

export interface A2uiActionEvent {
  name: string;
  context?: Record<string, unknown>;
}

export function readActionEvent(action: unknown): A2uiActionEvent | null {
  if (!isRecord(action) || !isRecord(action.event) || typeof action.event.name !== 'string') {
    return null;
  }
  const context = isRecord(action.event.context) ? action.event.context : undefined;
  return { name: action.event.name, context };
}

export function collectCheckedNodes(node: ResolvedNode, out: ResolvedNode[]): void {
  if (Array.isArray(node.props.checks)) {
    out.push(node);
  }
  for (const child of node.children) {
    collectCheckedNodes(child, out);
  }
}

/** Entries shaped `{ path: '/x' }` are read through `readPointer`; the rest pass through. */
export function resolveActionContext(
  context: Record<string, unknown> | undefined,
  readPointer: (pointer: string) => unknown,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(context ?? {})) {
    resolved[key] = isRecord(raw) && typeof raw.path === 'string' ? readPointer(raw.path) : raw;
  }
  return resolved;
}
