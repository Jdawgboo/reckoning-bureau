import { makeAutoObservable, observable } from 'mobx';
import type { AguiEvent } from '@/lib/agent-library';
import { isRecord } from '../util/type-guards.ts';
import { setAtPointer } from '../../../../vendor/agentplace-a2ui/data-model.ts';

/**
 * Holds the session `uiState` (the A2UI data model / per-session UI state)
 * delivered over the `agui` channel as AG-UI STATE events. The deployed
 * client has no StateTree, so this store IS the client-side mirror of the
 * server's `uiState` node. Handles both STATE_SNAPSHOT (full replace) and
 * STATE_DELTA (RFC-6902 subset) events.
 *
 * Dirty overlay: a server-side snapshot/delta can otherwise clobber an
 * unsynced local edit (user typing while another write broadcasts).
 * `setLocal` records the pointer as dirty; every incoming STATE event
 * re-applies the dirty overlay on top, pruning an entry only once the
 * incoming value at that pointer matches the local one. `markSynced` clears
 * the overlay after a successful action submit (see `SurfaceRenderer`'s
 * `stateUpdate` call).
 */
export class UiStateStore {
  state: Record<string, unknown> = {};

  /** Pointers written via `setLocal` since the last `markSynced`, with their
   *  local value — re-applied over every incoming STATE event. */
  #dirty = new Map<string, unknown>();

  constructor() {
    makeAutoObservable(this, { state: observable.ref });
  }

  applyStateEvent(event: AguiEvent): void {
    if (event.type === 'STATE_SNAPSHOT') {
      this.state = isRecord(event.snapshot) ? event.snapshot : {};
    } else if (event.type === 'STATE_DELTA') {
      this.state = applyJsonPatch(this.state, event.patch);
    } else {
      return;
    }
    this.#reapplyDirtyOverlay();
  }

  /** Client-originated local write (typing). Not sent to the server — the
   *  full document syncs on action submit. */
  setLocal(pointer: string, value: unknown): void {
    this.#dirty.set(pointer, value);
    const next = setAtPointer(this.state, pointer, value);
    this.state = isRecord(next) ? next : {};
  }

  /**
   * The document to send to the server, minus any pointer the caller marks
   * sensitive. Returns a copy: the live state keeps the full value so the field
   * still renders what the visitor typed — the value simply never leaves the
   * browser.
   *
   * Does NOT clear the dirty overlay. Only a full sync at action submit does
   * (`markSynced`), because a partial send leaves the server's copy incomplete
   * and an incoming snapshot must still lose to what is on screen.
   */
  syncableState(isSensitive: (pointer: string) => boolean): Record<string, unknown> {
    const redacted = structuredClone(this.state);
    for (const pointer of this.#dirty.keys()) {
      if (isSensitive(pointer)) {
        removeAtPointer(redacted, pointer);
      }
    }
    return redacted;
  }

  /** Clears the dirty overlay — call after a successful `stateUpdate` sync. */
  markSynced(): void {
    this.#dirty.clear();
  }

  /** Resolve a JSON Pointer (RFC 6901) against the current state. */
  get<T = unknown>(pointer: string): T | undefined {
    return resolveAtPointer(this.state, pointer) as T | undefined;
  }

  /** Re-applies every dirty pointer over `this.state`, pruning entries whose
   *  incoming value already matches the local one — an agent write that
   *  happens to agree with the visitor's in-progress input is not a
   *  conflict. */
  #reapplyDirtyOverlay(): void {
    if (this.#dirty.size === 0) {
      return;
    }
    let next: unknown = this.state;
    for (const [pointer, localValue] of this.#dirty) {
      const incomingValue = resolveAtPointer(next, pointer);
      if (deepEqual(incomingValue, localValue)) {
        this.#dirty.delete(pointer);
        continue;
      }
      next = setAtPointer(next, pointer, localValue);
    }
    this.state = isRecord(next) ? next : {};
  }
}

/** Delete whatever a JSON Pointer addresses, if the path exists. */
function removeAtPointer(root: Record<string, unknown>, pointer: string): void {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    return;
  }
  let cursor: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (!isRecord(cursor)) {
      return;
    }
    cursor = cursor[token];
  }
  if (isRecord(cursor)) {
    delete cursor[tokens[tokens.length - 1] as string];
  }
}

/** Resolve a JSON Pointer (RFC 6901) against an arbitrary root, never throws. */
function resolveAtPointer(root: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  let cursor: unknown = root;
  for (const token of tokens) {
    if (!isRecord(cursor) || !(token in cursor)) {
      return undefined;
    }
    cursor = cursor[token];
  }
  return cursor;
}

/** Structural equality for plain JSON-shaped data-model values (strings,
 *  numbers, booleans, objects, arrays) — sufficient for the dirty-overlay
 *  prune check; not a general-purpose deep-equal. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') {
    return [];
  }
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Minimal RFC-6902 subset: add / replace / remove by JSON Pointer. */
function applyJsonPatch(
  base: Record<string, unknown>,
  ops: Array<{ op: string; path: string; value?: unknown }>,
): Record<string, unknown> {
  const next = structuredClone(base);
  for (const op of ops) {
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) {
      continue;
    }
    const key = tokens[tokens.length - 1];
    let parent: Record<string, unknown> = next;
    for (const token of tokens.slice(0, -1)) {
      const child = parent[token];
      if (!isRecord(child)) {
        parent[token] = {};
      }
      parent = parent[token] as Record<string, unknown>;
    }
    if (op.op === 'remove') {
      delete parent[key];
    } else if (op.op === 'add' || op.op === 'replace') {
      parent[key] = op.value;
    }
  }
  return next;
}
