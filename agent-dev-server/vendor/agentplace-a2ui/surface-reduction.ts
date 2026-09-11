/**
 * Pure surface-state reduction as reusable functions. The SERVER uses these
 * to keep a per-session view of current surfaces (the source of the
 * reconnect resync: connect = snapshots, then live events); the client store
 * implements the same semantics. Upsert profile: createSurface on an
 * existing id resets it, which is exactly what makes re-emission on resync
 * idempotent.
 */

import { A2UI_EVENT_NAMES } from './event-names.ts';
import type { A2uiComponentNode } from './types.ts';
import { isRecord } from './type-guards.ts';

export interface ReducedSurface {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  fallbackMarkdown?: string;
  components: Map<string, A2uiComponentNode>;
  /** Run id of the turn that last touched this surface — carried through
   *  resync so a reconnecting client can re-associate surfaces with turns. */
  responseId?: string;
}

/** Apply one a2ui CUSTOM event to a mutable surface map. Malformed payloads
 *  and unknown-surface updates are dropped. Returns the touched surfaceId,
 *  or null when the event was a no-op. */
export function reduceSurfaceEvent(
  surfaces: Map<string, ReducedSurface>,
  name: string,
  value: unknown,
  responseId?: string,
): string | null {
  if (name === A2UI_EVENT_NAMES.createSurface) {
    if (!isRecord(value) || typeof value.surfaceId !== 'string') {
      return null;
    }
    if (typeof value.catalogId !== 'string') {
      return null;
    }
    surfaces.set(value.surfaceId, {
      surfaceId: value.surfaceId,
      catalogId: value.catalogId,
      theme: isRecord(value.theme) ? value.theme : undefined,
      fallbackMarkdown:
        typeof value.fallbackMarkdown === 'string' ? value.fallbackMarkdown : undefined,
      components: new Map(),
      responseId: responseId || undefined,
    });
    return value.surfaceId;
  }

  if (name === A2UI_EVENT_NAMES.updateComponents) {
    if (!isRecord(value) || typeof value.surfaceId !== 'string') {
      return null;
    }
    const surface = surfaces.get(value.surfaceId);
    if (!surface || !Array.isArray(value.components)) {
      return null;
    }
    for (const node of value.components) {
      if (!isRecord(node) || typeof node.id !== 'string' || typeof node.component !== 'string') {
        continue;
      }
      surface.components.set(node.id, node as A2uiComponentNode);
    }
    if (responseId) {
      surface.responseId = responseId;
    }
    return value.surfaceId;
  }

  if (name === A2UI_EVENT_NAMES.deleteSurface) {
    if (!isRecord(value) || typeof value.surfaceId !== 'string') {
      return null;
    }
    return surfaces.delete(value.surfaceId) ? value.surfaceId : null;
  }

  return null;
}

/** Re-express a reduced surface as the A2UI messages that rebuild it — the
 *  resync payload for a (re)connecting client. Idempotent under the upsert
 *  profile. */
export function surfaceToResyncEvents(
  surface: ReducedSurface,
): Array<{ name: string; value: unknown }> {
  return [
    {
      name: A2UI_EVENT_NAMES.createSurface,
      value: {
        surfaceId: surface.surfaceId,
        catalogId: surface.catalogId,
        ...(surface.theme ? { theme: surface.theme } : {}),
        ...(surface.fallbackMarkdown ? { fallbackMarkdown: surface.fallbackMarkdown } : {}),
      },
    },
    {
      name: A2UI_EVENT_NAMES.updateComponents,
      value: {
        surfaceId: surface.surfaceId,
        components: [...surface.components.values()],
      },
    },
  ];
}
