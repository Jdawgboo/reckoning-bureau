/**
 * The page for a turn that produced no surface — the assistant's text
 * answer, rendered as prose in the stage's answer typography. Reachable two
 * ways, both post-settlement: history navigation to a past text-only turn,
 * and the LIVE head once a typed (non-voice) turn finishes with no surface
 * of its own AND no prior surface to carry (the degenerate case of
 * `{kind:'answer'}` — see `resolveStageView`). Response text never claims
 * the page WHILE a turn is in flight; a voice-opened turn holds the
 * previous surface instead of landing here. Either way `turn.responseText`
 * is final by the time this renders — there is no streaming to show. No
 * hero title — the answer speaks for itself. Structured answers should be a
 * surface, not this.
 */
import type { FC } from 'react';
import { MarkdownText } from '@/app/lib/a2ui/blocks/MarkdownText.tsx';
import type { TurnEntry } from './turn-index.ts';

export interface TextPageProps {
  turn: TurnEntry;
}

/** The turn-answer prose block, shared by the standalone text page and the
 *  `{kind:'answer'}` composed view (prose above a carried surface) — one
 *  piece of markup, one typography, for every place an answer's text is
 *  the sole author of what's shown. */
export const AnswerProse: FC<{ text: string }> = ({ text }) => (
  <div className="pt-1">
    <MarkdownText text={text} />
  </div>
);

export const TextPage: FC<TextPageProps> = ({ turn }) => <AnswerProse text={turn.responseText} />;
