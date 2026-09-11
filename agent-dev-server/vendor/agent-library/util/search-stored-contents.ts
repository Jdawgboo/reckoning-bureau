/**
 * searchStoredContents — pure keyword recall search over a session's stored
 * conversation content, for the `recall_conversation` voice tool.
 *
 * Why: a voice agent only sees a rolling window of turns in its live model
 * context. When the visitor references something said earlier in the same
 * session but now outside that window, the agent needs a cheap way to pull
 * the relevant lines back out of full session storage without re-running the
 * model over the whole history. This is that lookup — synchronous, in-memory,
 * no LLM call.
 *
 * Scope: ordinary visible text plus dialogue the listener provably heard on
 * the selected spoken channel. Hidden internal content and reasoning remain
 * excluded. Full voice delivery exposes exact speech, partial delivery exposes
 * only an interruption marker, and unconfirmed delivery exposes nothing.
 *
 * Ranking: items are kept only if at least one query term appears in their
 * text (case-insensitive substring match). Among matches, more keyword hits
 * wins; ties fall back to recency (the more recent turn wins). The top 5
 * hits are formatted as `Earlier you/{userSpeakerLabel} said: "…"` — "you"
 * for the agent's own turns, `options.userSpeakerLabel` (default "the
 * visitor") for `role: 'user'` turns — each truncated to 200 characters, and
 * the whole response is capped at 1500 characters.
 *
 * @example
 * ```ts
 * const answer = searchStoredContents(await session.getStoredContents(0), 'refund policy');
 * // 'Earlier the visitor said: "can I get a refund if I cancel within 24 hours"'
 * ```
 */
import { ContentType } from '../types/content.ts';

/**
 * The minimal shape `searchStoredContents` needs from a stored content item.
 * Structurally compatible with `AgentContent` (`TextContent` in particular),
 * so both runtimes can pass their session's stored contents directly.
 */
export interface RecallableContent {
  responseId?: string;
  role?: string;
  hidden?: boolean;
  channel?: string;
  voiceDelivery?: { status: 'full' | 'partial' | 'unconfirmed'; runId?: string };
  isReasoning?: boolean;
  type: ContentType;
  content: unknown;
}

export const INTERRUPTED_SPOKEN_DELIVERY_TEXT =
  '[The voice response was interrupted before completion.]';

export interface ProjectedDialogueItem {
  responseId?: string;
  role: 'user' | 'assistant';
  text: string;
  source: 'ordinary' | 'spoken-user' | 'spoken-delivery';
  deliveryStatus?: 'full' | 'partial';
}

const MAX_SCAN_ITEMS = 500;
const TOP_MATCHES = 5;
const SNIPPET_CHAR_LIMIT = 200;
const MAX_TOTAL_CHARS = 1500;
const DEFAULT_USER_SPEAKER_LABEL = 'the visitor';
const NOTHING_FOUND_MESSAGE = 'Nothing found in this conversation — forward the question.';

interface ScoredSnippet {
  text: string;
  role?: string;
  score: number;
}

export interface SearchStoredContentsOptions {
  /**
   * How `role: 'user'` turns are named in a recalled snippet, e.g.
   * `Earlier {userSpeakerLabel} said: "…"`. Defaults to "the visitor"
   * (deployed-agent phrasing, addressed to an external visitor); builder
   * sessions pass "the user" (addressed to the agent's owner).
   */
  userSpeakerLabel?: string;
  /** Spoken channel whose hidden user turns and settled delivery evidence were heard. */
  spokenChannel?: string;
}

export function searchStoredContents(
  items: RecallableContent[],
  query: string,
  options?: SearchStoredContentsOptions,
): string {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return NOTHING_FOUND_MESSAGE;
  }

  const scanWindow = items.slice(-MAX_SCAN_ITEMS);
  const matches = collectMatchesNewestFirst(scanWindow, terms, options?.spokenChannel);
  if (matches.length === 0) {
    return NOTHING_FOUND_MESSAGE;
  }

  const userSpeakerLabel = options?.userSpeakerLabel ?? DEFAULT_USER_SPEAKER_LABEL;
  const top = rankMatches(matches).slice(0, TOP_MATCHES);
  const response = top.map((match) => formatSnippet(match, userSpeakerLabel)).join('\n');
  return truncateTo(response, MAX_TOTAL_CHARS);
}

/**
 * Projects the exact dialogue eligible to seed one spoken attachment. Seed
 * replay and deeper recall share `projectDialogueItem`, so they cannot drift
 * on hidden, partial, unconfirmed, or cross-channel delivery semantics.
 */
export function projectSpokenDialogue(
  items: RecallableContent[],
  spokenChannel: string,
): ProjectedDialogueItem[] {
  const dialogue: ProjectedDialogueItem[] = [];
  for (const item of items) {
    const projected = projectDialogueItem(item, spokenChannel);
    if (projected && projected.source !== 'ordinary') {
      dialogue.push(projected);
    }
  }
  return dialogue;
}

function collectMatchesNewestFirst(
  scanWindow: RecallableContent[],
  terms: string[],
  spokenChannel: string | undefined,
): ScoredSnippet[] {
  const matches: ScoredSnippet[] = [];
  for (let i = scanWindow.length - 1; i >= 0; i--) {
    const item = scanWindow[i];
    if (!item) {
      continue;
    }
    const projected = projectDialogueItem(item, spokenChannel);
    if (!projected) {
      continue;
    }

    const score = countKeywordHits(projected.text, terms);
    if (score === 0) {
      continue;
    }

    matches.push({ text: projected.text, role: projected.role, score });
  }
  return matches;
}

function projectDialogueItem(
  item: RecallableContent,
  spokenChannel: string | undefined,
): ProjectedDialogueItem | null {
  if (item.isReasoning || item.type !== ContentType.Text || typeof item.content !== 'string') {
    return null;
  }
  const text = item.content.trim();
  if (item.role === 'user' && spokenChannel !== undefined && item.channel === spokenChannel) {
    return text
      ? {
          responseId: item.responseId,
          role: 'user',
          text,
          source: 'spoken-user',
        }
      : null;
  }
  if (item.voiceDelivery !== undefined) {
    if (spokenChannel === undefined || item.channel !== spokenChannel) {
      return null;
    }
    if (item.voiceDelivery.status === 'unconfirmed') {
      return null;
    }
    if (item.voiceDelivery.status === 'partial') {
      return {
        responseId: item.responseId,
        role: 'assistant',
        text: INTERRUPTED_SPOKEN_DELIVERY_TEXT,
        source: 'spoken-delivery',
        deliveryStatus: 'partial',
      };
    }
    return text
      ? {
          responseId: item.responseId,
          role: 'assistant',
          text,
          source: 'spoken-delivery',
          deliveryStatus: 'full',
        }
      : null;
  }
  if (item.hidden || !text) {
    return null;
  }
  return {
    responseId: item.responseId,
    role: item.role === 'user' ? 'user' : 'assistant',
    text,
    source: 'ordinary',
  };
}

/**
 * Sorts by score descending; ties keep their existing order, which is
 * already newest-first from `collectMatchesNewestFirst`, so recency breaks
 * ties without extra bookkeeping.
 */
function rankMatches(matches: ScoredSnippet[]): ScoredSnippet[] {
  return [...matches].sort((a, b) => b.score - a.score);
}

function formatSnippet(match: ScoredSnippet, userSpeakerLabel: string): string {
  const speaker = match.role === 'user' ? userSpeakerLabel : 'you';
  return `Earlier ${speaker} said: "${truncateTo(match.text, SNIPPET_CHAR_LIMIT)}"`;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
}

function countKeywordHits(text: string, terms: string[]): number {
  const lowered = text.toLowerCase();
  return terms.reduce((total, term) => total + countOccurrences(lowered, term), 0);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function truncateTo(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}
