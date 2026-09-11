/**
 * Assembles what the voice model is told about the current screen: its
 * structure, the values the visitor has put into it, and which of those must
 * never be spoken.
 *
 * Pure and standalone — `AgentSession` holds the two inputs (the reduced
 * surface map and the cached uiState) but has no business knowing how a screen
 * is described. Keeping this out of the session also makes it node-loadable and
 * testable without the session's runtime import graph.
 */

import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import { isSensitiveFieldKind } from '../../vendor/agentplace-a2ui/field-sensitivity.ts';
import type { VoiceScreenSnapshot } from '../../vendor/agentplace-voice/voice-context-projector.ts';
import {
  BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS,
  type BrowserVoiceScreenSelection,
} from '../../../shared/ws-protocol.ts';
import { isRecord } from '../util/type-guards.ts';
import { visibleSections } from './surface-carry-forward.ts';

const MAX_SURFACE_ID_CHARS = 256;

export type VoiceScreen = Extract<VoiceScreenSnapshot, { kind: 'structured' }>;

/** Mutable, ephemeral screen source owned by exactly one `/voice` attachment. */
export interface AttachmentVoiceScreenSource {
  read(): VoiceScreenSnapshot | null;
  update(selection: unknown): VoiceScreenSelectionUpdate;
}

/** Safe outcome recorded when an attachment proposes a new visible selection. */
export type VoiceScreenSelectionUpdate =
  | { status: 'updated' }
  | { status: 'cleared' }
  | { status: 'rejected'; reason: 'invalid-shape' | 'oversized' };

/**
 * One `/voice` connection's current browser selection. Surface structure and
 * values remain server-owned; an untrusted browser can select only a surface
 * the session has actually rendered or provide bounded visible text.
 */
export function createAttachmentVoiceScreenSource(options: {
  resolveSurface: (surfaceId: string) => VoiceScreen | null;
}): AttachmentVoiceScreenSource {
  let current: BrowserVoiceScreenSelection = null;
  return {
    read: () => {
      if (current === null) {
        return null;
      }
      if (current.kind === 'text') {
        return { kind: 'text', text: current.text };
      }
      return options.resolveSurface(current.surfaceId);
    },
    update: (selection) => {
      const parsed = parseBrowserScreenSelection(selection);
      if (parsed.status === 'rejected') {
        current = null;
        return parsed;
      }
      // A well-formed surface intent is stored even when nothing resolves for
      // it yet: `read()` resolves fresh every time, so a selection sent while
      // its render is still landing starts answering the moment the surface
      // exists instead of leaving voice blind until the browser re-sends.
      // Naming a surface this session never rendered yields a null read — the
      // authorization boundary is resolution, not storage.
      current = parsed.selection;
      return { status: current === null ? 'cleared' : 'updated' };
    },
  };
}

/**
 * The current screen as voice needs it, or `null` when there is nothing to
 * describe. The screen is common ground — the visitor is looking at it — so
 * holding its structure leaks nothing; values of sensitive kinds are withheld
 * regardless, because voice speaks straight to the wire with no tool-call audit
 * point in between.
 */
export function buildVoiceScreen(
  surface: ReducedSurface | undefined,
  uiState: Record<string, unknown> | null,
  surfaceId: string,
): VoiceScreen | null {
  const sections = visibleSections(surface);
  if (sections.length === 0) {
    return null;
  }
  const sensitiveIds = collectSensitiveFieldIds(sections);
  return {
    kind: 'structured',
    sections,
    values: readSurfaceValues(uiState, surfaceId),
    fallbackMarkdown: sensitiveIds.size === 0 ? surface?.fallbackMarkdown : undefined,
    isSensitive: (fieldId) => sensitiveIds.has(fieldId),
  };
}

function parseBrowserScreenSelection(
  selection: unknown,
):
  | { status: 'accepted'; selection: BrowserVoiceScreenSelection }
  | Extract<VoiceScreenSelectionUpdate, { status: 'rejected' }> {
  if (selection === null) {
    return { status: 'accepted', selection: null };
  }
  if (!isRecord(selection) || typeof selection['kind'] !== 'string') {
    return { status: 'rejected', reason: 'invalid-shape' };
  }
  if (selection['kind'] === 'surface') {
    const surfaceId = selection['surfaceId'];
    if (typeof surfaceId !== 'string' || surfaceId.trim() === '') {
      return { status: 'rejected', reason: 'invalid-shape' };
    }
    if (surfaceId.length > MAX_SURFACE_ID_CHARS) {
      return { status: 'rejected', reason: 'oversized' };
    }
    return {
      status: 'accepted',
      selection: { kind: 'surface', surfaceId },
    };
  }
  if (selection['kind'] === 'text') {
    const text = selection['text'];
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'rejected', reason: 'invalid-shape' };
    }
    if (text.length > BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS) {
      return { status: 'rejected', reason: 'oversized' };
    }
    return { status: 'accepted', selection: { kind: 'text', text: text.trim() } };
  }
  return { status: 'rejected', reason: 'invalid-shape' };
}

/** Reads each section's own `kind` declarations rather than guessing from prop
 *  shape — a component that takes input some other way must not slip through. */
function collectSensitiveFieldIds(
  sections: ReadonlyArray<{ props: Record<string, unknown> }>,
): Set<string> {
  const ids = new Set<string>();
  for (const section of sections) {
    const fields = section.props['fields'];
    if (!Array.isArray(fields)) {
      continue;
    }
    for (const field of fields) {
      if (
        isRecord(field) &&
        typeof field['id'] === 'string' &&
        isSensitiveFieldKind(field['kind'])
      ) {
        ids.add(field['id']);
      }
    }
  }
  return ids;
}

/**
 * Values the visitor has entered on `surfaceId`, flattened to field ids.
 * Components publish under grouped pointers (a form writes `/form/{fieldId}`),
 * so one level of grouping is collapsed — the projection speaks in field names,
 * not pointers.
 */
function readSurfaceValues(
  uiState: Record<string, unknown> | null,
  surfaceId: string,
): Record<string, unknown> {
  const surfaces = uiState?.['surfaces'];
  if (!isRecord(surfaces)) {
    return {};
  }
  const scoped = surfaces[surfaceId];
  if (!isRecord(scoped)) {
    return {};
  }
  const values: Record<string, unknown> = {};
  for (const group of Object.values(scoped)) {
    if (isRecord(group)) {
      Object.assign(values, group);
    }
  }
  return values;
}
