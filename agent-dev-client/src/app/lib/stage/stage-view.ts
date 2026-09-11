/**
 * Pure page-area resolution for the stage shell. Every gate that has caused
 * a shipped regression lives here, table-tested:
 * - keys are turn-index based (the optimistic user message has no responseId
 *   until the server echo replaces it; an identity-based key remounts the
 *   page mid-turn),
 * - the restore fallback applies only to identity-less turns (a live turn
 *   that already has a responseId must not get overwritten by an older,
 *   unrelated resynced surface),
 * - nothing pre-empts the page during a request except real new content
 *   (surface, process page) — the previous page holds. Response text NEVER
 *   claims the page WHILE THE TURN IS IN FLIGHT, on any channel: streamed
 *   prose flashing onto the page and then getting swapped for the eventual
 *   surface is the regression this guards against,
 * - once the run SETTLES with no surface of its own, a TYPED turn's text
 *   answers OVER whatever surface was already current at that turn
 *   (the carried surface, by reference — see
 *   `findCarriedSurfaceId`) rather than replacing it: an answer must never
 *   destroy the screen it is about. `{kind:'text'}` (`TextPage`, reused
 *   from history) is the degenerate case — no surface ever existed to carry.
 *   Either way a finished text-only answer must land on screen, not vanish
 *   into a held or blank page. A VOICE-opened turn instead holds whatever
 *   page was already live: the answer was spoken, so swapping the screen
 *   would contradict it. Prose meant to accompany other blocks still
 *   belongs INSIDE the screen (a TextBlock section in a SectionStack), not
 *   here.
 * - the "nothing to show" page is one honest state: `loading`. An idle
 *   stage with nothing renderable is not a designed product state — the
 *   welcome turn (or restored content) must always arrive. If `loading`
 *   is still on screen after the run settles, that is a BUG to fix at its
 *   root (a status lie, a restore gap), never a state to design a calm
 *   screen for.
 *
 * React-free: returns a descriptor; StageShell maps it to JSX.
 */
import type { TurnEntry } from './turn-index.ts';
import {
  BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS,
  type BrowserVoiceScreenSelection,
} from '../../../../../shared/ws-protocol.ts';

export type StageView =
  | {
      kind: 'surface';
      key: string;
      surfaceId: string;
    }
  | { kind: 'process'; key: string; turnIndex: number }
  | { kind: 'text'; key: string; turnIndex: number }
  | { kind: 'loading'; key: 'loading' };

export interface StageViewInput {
  turns: TurnEntry[];
  /** Rail selection; null = live head. */
  selectedIndex: number | null;
  /** Live surface records in insertion order (latest last). */
  surfaces: ReadonlyArray<{
    id: string;
    responseId?: string;
    lastTouchedResponseId?: string;
    /** Whether the surface has rendered any component yet. A surface exists from
     *  its `createSurface` frame, which the render tool emits BEFORE the first
     *  section is complete — so an empty one must not take the page, or the
     *  screen swaps to a blank frame and fills in afterwards. */
    hasContent?: boolean;
  }>;
  /** Stable key of the active, registered process part; null otherwise. */
  processPartKey: string | null;
  userRequestPending: boolean;
  /** A voice-originated run is working — the process page must not be gated
   *  on typed sends alone; spoken requests deserve the same working page. */
  voiceRunActive?: boolean;
}

/** The page may show a completed progressive section before the run ends.
 *  Working chrome therefore follows the response lifecycle, never the page
 *  descriptor selected by `resolveStageView`. */
export function isStageRunActive(userRequestPending: boolean): boolean {
  return userRequestPending;
}

/**
 * Normalizes the page the browser actually renders into the small wire
 * contract voice understands. The server resolves surface structure and
 * values; the browser supplies only its attachment-local selection.
 */
export function voiceScreenSelectionForStage(options: {
  view: StageView;
  turns: ReadonlyArray<TurnEntry>;
  chatMode: boolean;
  processNarration: string;
  copy: {
    transcriptOpen: string;
    workInProgress: string;
    screenTextTruncated: string;
  };
}): BrowserVoiceScreenSelection {
  if (options.chatMode) {
    return { kind: 'text', text: options.copy.transcriptOpen };
  }
  switch (options.view.kind) {
    case 'surface':
      // A surface view is by construction the live screen; naming the surface
      // is the whole selection — the server resolves its own latest state.
      return { kind: 'surface', surfaceId: options.view.surfaceId };
    case 'text': {
      const text = boundedVisibleText(
        options.turns[options.view.turnIndex]?.responseText ?? '',
        options.copy.screenTextTruncated,
      );
      return text ? { kind: 'text', text } : null;
    }
    case 'process': {
      const narration = boundedVisibleText(
        options.processNarration,
        options.copy.screenTextTruncated,
      );
      return { kind: 'text', text: narration || options.copy.workInProgress };
    }
    case 'loading':
      return null;
  }
}

function boundedVisibleText(text: string, marker: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS) {
    return trimmed;
  }
  const separatedMarker = ` ${marker}`;
  return `${trimmed.slice(0, BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS - separatedMarker.length)}${separatedMarker}`;
}

/** Only a page with real content is worth carrying forward across a turn —
 *  `loading` is a "nothing yet" state, never a held page. */
function isHoldable(view: StageView): boolean {
  return view.kind !== 'loading';
}

function latestRenderableSurface(
  surfaces: StageViewInput['surfaces'],
): StageViewInput['surfaces'][number] | undefined {
  return [...surfaces].reverse().find((surface) => surface.hasContent !== false);
}

/**
 * The surface a text-only turn should carry its answer over: the most
 * recent surface at or before `index`, walking `turns` backwards. Identity
 * is required on BOTH sides — a turn with no `responseId` is skipped rather
 * than matched to an identity-less (resynced) surface, mirroring the reason
 * `undefined === undefined` is rejected in the live-head/history match
 * above. Returns `null` when no turn up to `index` ever produced a surface
 * that is still live — the degenerate case callers fall back to
 * `{kind:'text'}` for.
 */
/**
 * A turn owns a surface if it created it OR was the last to render into it.
 * Both identities are needed: the rail resolves an older turn by creation, the
 * live head resolves the current turn by its most recent render.
 *
 * A surface with no content yet is NOT a match: it exists only because
 * `createSurface` precedes the first section, and taking the page at that
 * moment blanks whatever the visitor was reading. Skipping it keeps the hold
 * in place until there is something to swap TO, so the screen changes once.
 */
function surfaceForTurn(
  surfaces: StageViewInput['surfaces'],
  responseId: string,
): StageViewInput['surfaces'][number] | undefined {
  return surfaces.find(
    (candidate) =>
      candidate.hasContent !== false &&
      (candidate.responseId === responseId || candidate.lastTouchedResponseId === responseId),
  );
}

export function findCarriedSurfaceId(
  turns: ReadonlyArray<TurnEntry>,
  surfaces: StageViewInput['surfaces'],
  index: number,
): string | null {
  for (let i = index; i >= 0; i--) {
    const responseId = turns[i]?.responseId;
    if (!responseId) {
      continue;
    }
    const surface = surfaceForTurn(surfaces, responseId);
    if (surface) {
      return surface.id;
    }
  }
  return null;
}

/**
 * `prevLive` is the last PAGE this resolver produced AT THE LIVE HEAD
 * (callers must not feed a history-resolved view back in — a history detour
 * must not become the held page). It is returned unchanged when the live
 * turn has produced nothing yet: the page stays, one transition per turn.
 *
 * One rule governs the order below: **never disturb a page to signal that work
 * is happening.** A process page replaces whatever the visitor was reading, so
 * when a screen is already up it is held instead — swapping to `process` reads
 * as the whole page refreshing and discards the screen continuity exists to
 * preserve. The hold returns `prevLive` BY REFERENCE, because "same object"
 * is the signal consumers use to skip work.
 *
 * The same rule decides what a text-only turn shows. Over an existing screen it
 * resolves to THAT SCREEN: reply text is conversation rather than page content,
 * and the agent is told to put anything readable into the screen's own prose
 * section — painting it above the surface as well would show the same answer
 * twice, once inside the screen and once floating over it. Only when nothing was
 * ever rendered does prose own the page (`{kind:'text'}`).
 */
export function resolveStageView(input: StageViewInput, prevLive: StageView | null): StageView {
  const liveHeadIndex = input.turns.length - 1;
  const resolvedIndex = input.selectedIndex !== null ? input.selectedIndex : liveHeadIndex;
  const turn = resolvedIndex >= 0 ? input.turns[resolvedIndex] : undefined;
  const atLiveHead = input.selectedIndex === null || input.selectedIndex === liveHeadIndex;

  if (!atLiveHead) {
    return resolveHistoryView(input, resolvedIndex, turn);
  }

  // Identity match requires an identity on BOTH sides: `undefined ===
  // undefined` would "match" any resynced (identity-less) surface — showing
  // the wrong restored surface and letting a stale one pre-empt a pending
  // request through the match branch.
  const matched = turn?.responseId ? surfaceForTurn(input.surfaces, turn.responseId) : undefined;
  let displaySurfaceId = matched?.id ?? null;

  // Restore fallback: only when the turn's identity is UNKNOWN (restored
  // history after a reload, or an echo edge) and nothing is in flight.
  if (!displaySurfaceId && !input.userRequestPending && !turn?.responseId) {
    const latest = input.surfaces[input.surfaces.length - 1];
    displaySurfaceId = latest ? latest.id : null;
  }

  if (displaySurfaceId) {
    return {
      kind: 'surface',
      key: `surface:${displaySurfaceId}:live`,
      surfaceId: displaySurfaceId,
    };
  }

  if (input.userRequestPending && prevLive?.kind === 'surface') {
    const previousStillExists = input.surfaces.some((surface) => surface.id === prevLive.surfaceId);
    if (previousStillExists) {
      return prevLive;
    }
    const restored = latestRenderableSurface(input.surfaces);
    if (restored) {
      return {
        kind: 'surface',
        key: `surface:${restored.id}:live`,
        surfaceId: restored.id,
      };
    }
  }

  if ((input.userRequestPending || input.voiceRunActive) && input.processPartKey) {
    return { kind: 'process', key: `process:${input.processPartKey}`, turnIndex: resolvedIndex };
  }

  if (!input.userRequestPending && turn?.responseText && turn.channel !== 'voice') {
    const carriedSurfaceId = findCarriedSurfaceId(input.turns, input.surfaces, resolvedIndex);
    if (carriedSurfaceId) {
      return {
        kind: 'surface',
        key: `surface:${carriedSurfaceId}:live`,
        surfaceId: carriedSurfaceId,
      };
    }
    return { kind: 'text', key: `text:${resolvedIndex}`, turnIndex: resolvedIndex };
  }

  if (prevLive && isHoldable(prevLive)) {
    return prevLive;
  }
  return { kind: 'loading', key: 'loading' };
}

/**
 * History no longer freezes a per-turn copy of the screen: a past turn's
 * surface is resolved from the LIVE store by the same responseId-identity
 * rule the live head uses (identity required on BOTH sides — see the match
 * above) — fully interactive, current data. The key is namespaced
 * `history-<index>` rather than `:live` so selecting the same surface from
 * the rail and from the live head still remounts (distinct identity),
 * keeping the swap animation and scroll-reset behavior sane.
 */
function resolveHistoryView(
  input: StageViewInput,
  resolvedIndex: number,
  turn: TurnEntry | undefined,
): StageView {
  const matched = turn?.responseId ? surfaceForTurn(input.surfaces, turn.responseId) : undefined;
  if (matched) {
    return {
      kind: 'surface',
      key: `surface:${matched.id}:history-${resolvedIndex}`,
      surfaceId: matched.id,
    };
  }
  if (turn?.responseText) {
    const carriedSurfaceId = findCarriedSurfaceId(input.turns, input.surfaces, resolvedIndex);
    if (carriedSurfaceId) {
      return {
        kind: 'surface',
        key: `surface:${carriedSurfaceId}:history-${resolvedIndex}`,
        surfaceId: carriedSurfaceId,
      };
    }
    return { kind: 'text', key: `text:${resolvedIndex}`, turnIndex: resolvedIndex };
  }
  return { kind: 'loading', key: 'loading' };
}
