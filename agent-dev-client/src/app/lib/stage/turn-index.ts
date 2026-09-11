import {
  ContentType,
  computeMessageGroups,
  type AgentContent,
  type MessageGroup,
} from '../../../lib/agent-library.ts';

export interface TurnEntry {
  /** Stable unique identity of this turn's opening content item. */
  id: string;
  /** Run correlation id. Multiple turns may legitimately share it. */
  responseId?: string;
  /** The user's message text that opened this turn. Empty for `home` turns. */
  request: string;
  /** First ~160 chars of assistant text for the turn rail's peek card. */
  responsePreview: string;
  /** Full assistant text for the turn, uncapped. Rendered by the stage's
   *  text page (`TextPage`) for a history turn without a matching live
   *  surface, or at the live head once a typed turn settles with no surface
   *  of its own — see `resolveStageView`. Never shown while a turn is in
   *  flight. */
  responseText: string;
  /** True when the turn has no visible user request: a HIDDEN user message
   *  (the welcome scenario, `[user opened the agent]`) or, on the session's
   *  first turn, no user message at all (a restored greeting stream). The
   *  turn IS a page — the site's home — so it must exist in the index; the
   *  rail labels it "Home" instead of showing the synthetic request text. */
  home?: boolean;
  /** Channel that opened the turn, e.g. `'voice'`. Undefined for typed turns
   *  and for any turn restored via resume-reconstruct (not persisted).
   *  Consumed by `resolveStageView` as the settled-turn discriminator: a
   *  typed text-only turn becomes the deferred text page, a voice one holds
   *  the previous surface instead (a spoken answer should not swap the
   *  screen from under it). */
  channel?: string;
}

const RESPONSE_PREVIEW_MAX_CHARS = 160;

/**
 * Fold the flat message list into turn entries for the turn rail.
 *
 * A thin projection of `computeMessageGroups` — the shared run-based grouper
 * in `agent-library` (see `docs/superpowers/specs/2026-07-24-turn-model-unification.md`)
 * — onto the rail's display shape. One `TurnEntry` per group, in order.
 * `home` turns (a hidden user message, or orphan agent content on the
 * session's first turn) are kept rather than dropped: the welcome turn is
 * the site's home page, and skipping it would leave the stage with nothing
 * to display for the most important turn of the session. Every
 * non-reasoning assistant text response in a group accumulates into both
 * the turn's capped preview (`responsePreview`) and its uncapped
 * `responseText`.
 */
export function buildTurnIndex(messages: AgentContent[]): TurnEntry[] {
  return computeMessageGroups(messages).map(toTurnEntry);
}

function toTurnEntry(group: MessageGroup): TurnEntry {
  const entry: TurnEntry = {
    id: turnIdentity(group),
    responseId: group.responseId,
    request: visibleRequestText(group.request),
    responsePreview: '',
    responseText: '',
    home: group.kind === 'home' ? true : undefined,
    channel: group.request?.channel,
  };

  for (const response of group.responses) {
    accumulateResponse(entry, response);
  }

  return entry;
}

function turnIdentity(group: MessageGroup): string {
  return group.request?.messageId ?? group.responses[0]?.messageId ?? group.id;
}

function visibleRequestText(request: AgentContent | null): string {
  if (!request || request.hidden || request.type !== ContentType.Text) {
    return '';
  }
  return request.content;
}

function accumulateResponse(entry: TurnEntry, message: AgentContent): void {
  if (message.type !== ContentType.Text || message.isReasoning || message.hidden) {
    return;
  }

  entry.responseText = `${entry.responseText} ${message.content}`.trim();
  if (entry.responsePreview.length < RESPONSE_PREVIEW_MAX_CHARS) {
    entry.responsePreview = `${entry.responsePreview} ${message.content}`
      .trim()
      .slice(0, RESPONSE_PREVIEW_MAX_CHARS);
  }
}
