import { makeAutoObservable, observable } from 'mobx';
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';
import type { A2uiComponentNode, A2uiSurface } from '../../../../vendor/agentplace-a2ui/types.ts';
import { isRecord } from '../util/type-guards.ts';

/**
 * Client-only extension of the wire-level `A2uiSurface`: stamps the platform
 * run id (`responseId`) of the turn whose `createSurface` frame produced this
 * surface. Not part of the A2UI wire contract — used by the stage shell's
 * turn rail to associate a surface with the turn that created it.
 */
export interface A2uiSurfaceRecord extends A2uiSurface {
  /** The turn that CREATED this surface. Never reassigned — the rail needs a
   *  stable owner, or a later turn re-rendering the screen steals the creating
   *  turn's entry and it degrades to text/loading. */
  responseId?: string;
  /** The most recent turn to render into it. Drives live-head resolution,
   *  which must follow the newest render rather than creation. */
  lastTouchedResponseId?: string;
  /**
   * A `createSurface` re-render arrived and the replacing nodes have not yet
   * landed. The previous components stay mounted meanwhile; the next
   * `updateComponents` REPLACES them wholesale instead of merging.
   */
  awaitingReplacement?: boolean;
}

type SurfaceMap = ReadonlyMap<string, A2uiSurfaceRecord>;

/**
 * Holds A2UI surfaces delivered over the `agui` channel as
 * `agentplace.a2ui.*` CUSTOM events.
 *
 * updateComponents replaces nodes wholesale by id; dangling child refs are
 * kept; `createSurface` on an existing surfaceId is an upsert (an
 * intentional Agentplace deviation from A2UI, which errors without a
 * delete-first — stateless authoring makes re-render-with-new-props the
 * dominant operation) that resets the surface's components/catalogId/theme;
 * unknown-surface updates and malformed payloads are dropped (bad nodes
 * skipped individually).
 *
 * Events arrive as a create+update PAIR. Re-creating an EXISTING surface does
 * not empty it: emptying is observable, and an observable empty surface
 * unmounts the whole tree — discarding whatever the visitor had typed —
 * however stable the node ids are. Instead the previous components stay
 * mounted and the surface is marked `awaitingReplacement`, so the following
 * `updateComponents` replaces them wholesale (no merge, so nothing orphaned)
 * and React reconciles by id. This holds whether or not the two events arrive
 * in the same tick, which is why it is preferred to batching them.
 *
 * `applySurfaceEvents` additionally folds a same-tick batch into one
 * assignment; the per-event reducers are pure to make that possible.
 */
export class A2uiSurfaceStore {
  surfaces: SurfaceMap = new Map();

  constructor() {
    makeAutoObservable(this, { surfaces: observable.ref });
  }

  /** Applies a batch of surface events as ONE observable write. */
  applySurfaceEvents(
    events: ReadonlyArray<{ name: string; value: unknown }>,
    responseId?: string,
  ): void {
    let next = this.surfaces;
    for (const event of events) {
      next = reduceSurfaceEvent(next, event.name, event.value, responseId);
    }
    if (next !== this.surfaces) {
      this.surfaces = next;
    }
  }

  applySurfaceEvent(name: string, value: unknown, responseId?: string): void {
    this.applySurfaceEvents([{ name, value }], responseId);
  }
}

function reduceSurfaceEvent(
  surfaces: SurfaceMap,
  name: string,
  value: unknown,
  responseId?: string,
): SurfaceMap {
  if (name === A2UI_EVENT_NAMES.createSurface) {
    return createSurface(surfaces, value, responseId);
  }
  if (name === A2UI_EVENT_NAMES.updateComponents) {
    return updateComponents(surfaces, value, responseId);
  }
  if (name === A2UI_EVENT_NAMES.deleteSurface) {
    return deleteSurface(surfaces, value);
  }
  return surfaces;
}

function createSurface(surfaces: SurfaceMap, value: unknown, responseId?: string): SurfaceMap {
  if (!isRecord(value) || typeof value.surfaceId !== 'string') {
    return surfaces;
  }
  if (typeof value.catalogId !== 'string') {
    return surfaces;
  }
  const existing = surfaces.get(value.surfaceId);
  return withSurface(surfaces, {
    surfaceId: value.surfaceId,
    catalogId: value.catalogId,
    theme: isRecord(value.theme) ? value.theme : undefined,
    components: existing?.components ?? new Map(),
    awaitingReplacement: existing !== undefined,
    responseId: existing?.responseId ?? responseId,
    lastTouchedResponseId: responseId ?? existing?.lastTouchedResponseId,
  });
}

function updateComponents(surfaces: SurfaceMap, value: unknown, responseId?: string): SurfaceMap {
  if (!isRecord(value) || typeof value.surfaceId !== 'string') {
    return surfaces;
  }
  const existing = surfaces.get(value.surfaceId);
  if (!existing) {
    console.warn('[A2uiSurfaceStore] update for unknown surface', value.surfaceId);
    return surfaces;
  }
  if (!Array.isArray(value.components)) {
    return surfaces;
  }
  const components = existing.awaitingReplacement ? new Map() : new Map(existing.components);
  for (const node of value.components) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.component !== 'string') {
      continue; // skip malformed nodes individually
    }
    components.set(node.id, node as A2uiComponentNode);
  }
  return withSurface(surfaces, {
    ...existing,
    components,
    awaitingReplacement: false,
    lastTouchedResponseId: responseId ?? existing.lastTouchedResponseId,
  });
}

function deleteSurface(surfaces: SurfaceMap, value: unknown): SurfaceMap {
  if (!isRecord(value) || typeof value.surfaceId !== 'string') {
    return surfaces;
  }
  if (!surfaces.has(value.surfaceId)) {
    return surfaces;
  }
  const next = new Map(surfaces);
  next.delete(value.surfaceId);
  return next;
}

function withSurface(surfaces: SurfaceMap, surface: A2uiSurfaceRecord): SurfaceMap {
  const next = new Map(surfaces);
  next.set(surface.surfaceId, surface);
  return next;
}
