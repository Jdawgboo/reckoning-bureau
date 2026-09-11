/**
 * States the situation of THIS turn to the agent, in words, instead of leaving
 * it to infer one from a JSON blob.
 *
 * `metadata.channel` used to reach the model only inside
 * `<internal_request_metadata>` with no directive attached — so the one fact
 * that decides whether rendering is appropriate arrived as trivia. The
 * presentation contract answers "how do screens work here"; this answers "who
 * is on the other end of this particular turn".
 *
 * Channel-derived defaults state facts and leave rendering judgment with the
 * agent. A trusted presentation capability may also state a hard UI boundary;
 * that wording mirrors the tool grants enforced for the same run.
 *
 * **Delivered as a model middleware, never appended to the query text.** The
 * query becomes the canonical user message in conversation history
 * (`TurnInputProcessor`), so anything folded into it is persisted AS the
 * visitor's own words — and surfaces wherever those words are displayed, like
 * the turn rail's title. Per-turn context belongs in `transformParams`, which
 * shapes the outgoing request and leaves history alone; `<ui_state>` uses the
 * same mechanism for the same reason.
 */

import { channelHasLiveScreen, type TurnChannel } from '../../ws/resolve-turn-channel.ts';
import type { SessionPresentationLocale } from '../../../../shared/index.ts';
import type { StableUiLocalizationStatus } from '../../ws/agent-session.ts';

/**
 * Someone is waiting in silence while this turn runs, and unlike a screen there
 * is nothing for them to watch. Stated here rather than in the tool description
 * alone, because the decision to speak belongs to the turn, not to the tool.
 */
const WAITING_LISTENER_NOTE =
  'They are waiting in silence while you work: if this turn takes a while, call report_progress ' +
  'once you have actually finished something they would care about.';

/** Every channel whose caller hears the answer rather than reading it. */
function isSpokenChannel(channel: TurnChannel): boolean {
  return channel === 'voice' || channel === 'phone';
}

export function formatTurnSituation(
  channel: TurnChannel | undefined,
  presentation?: {
    screenContext: 'live' | 'absent';
    uiEffects: 'allowed' | 'forbidden';
  },
): string {
  if (!channel) {
    return '';
  }
  const situation = situationFor(channel, presentation);
  // Appended here rather than inside each spoken branch, so a channel added
  // later — a telephone call above all — cannot quietly lose it by returning
  // its own sentence first.
  const stated = isSpokenChannel(channel) ? `${situation} ${WAITING_LISTENER_NOTE}` : situation;
  return ['<turn_situation>', stated, '</turn_situation>'].join('\n');
}

function situationFor(
  channel: TurnChannel,
  presentation?: {
    screenContext: 'live' | 'absent';
    uiEffects: 'allowed' | 'forbidden';
  },
): string {
  const hasLiveScreen = presentation
    ? presentation.screenContext === 'live'
    : channelHasLiveScreen(channel);
  const uiEffectsAllowed = presentation?.uiEffects !== 'forbidden';

  // Before the generic screenless branch: that branch's advice ("a complete,
  // well-formatted written answer") is right for an HTTP or MCP caller reading
  // markdown and wrong for someone holding a phone to their ear.
  if (channel === 'phone') {
    return 'The caller is on a telephone call — they hear your words spoken aloud and see nothing. Answer in short spoken sentences. No markdown, no lists, no URLs read aloud. Spell out critical details (names, dates, amounts), and spell anything that has to be exact — an address, an email — slowly enough to be written down. There is no way to text or email something to a caller, so never offer one. Never mention screens or anything visual.';
  }
  if (channel === 'voice' && !hasLiveScreen) {
    return uiEffectsAllowed
      ? 'This request was spoken and there is NO live screen. Answer completely in speech; any structured content reaches the caller only as its markdown fallback.'
      : 'This request was spoken and there is NO live screen. Answer completely in speech; do not render or change any UI.';
  }
  if (!hasLiveScreen) {
    if (!uiEffectsAllowed) {
      return `This request came over ${channel}. There is NO live screen and UI effects are unavailable. Give a complete written answer without rendering or changing UI.`;
    }
    return `This request came over ${channel}. There is NO live screen: anything you render reaches the caller only as its markdown fallback. Prefer a complete, well-formatted written answer; render only when structured content genuinely is the best answer.`;
  }
  if (channel === 'voice') {
    return uiEffectsAllowed
      ? 'This request was spoken. The visitor is looking at a screen and can hear you: your reply text is spoken aloud, so it is a real delivery on its own. Render only if they asked to see something new or changed.'
      : 'This request was spoken. The visitor can hear you and you may refer to the current screen, but you must not render or change UI.';
  }
  if (channel === 'screen') {
    return 'The visitor acted on the screen itself (a tap or a submit) rather than typing a question.';
  }
  return 'The visitor typed this while looking at the current screen.';
}

export function formatSessionLocaleSituation(
  locale: SessionPresentationLocale,
  stableUi: StableUiLocalizationStatus,
): string {
  const stableUiFact = stableUiSituation(stableUi);
  return [
    '<session_locale>',
    `Committed message locale: ${locale.messageLocale}. Formatting locale: ${locale.formatLocale}. Authority: ${locale.source}.`,
    localeTransitionSituation(locale, 'SetSessionLocale'),
    'Write new response prose and response-specific Render component props in the committed ' +
      'message locale. Preserve brands, names, identifiers, addresses, URLs, prices, units, ' +
      'dates, hours, eligibility, policy effects, form values, and other facts.',
    'Stable buttons, labels, menus, placeholders, validation, and accessibility wording are ' +
      'bundle-owned; do not invent or persist translations for them.',
    stableUiFact,
    '</session_locale>',
  ].join('\n');
}

export function formatVoiceLocaleSituation(locale: SessionPresentationLocale): string {
  return [
    '<session_locale>',
    `The committed conversation language is ${locale.messageLocale}. Authority: ${locale.source}.`,
    localeTransitionSituation(locale, 'set_session_locale'),
    'Speak in the resulting committed language. Preserve brands, names, identifiers, addresses, ' +
      'URLs, prices, units, dates, hours, eligibility, policy effects, form values, and other facts.',
    '</session_locale>',
  ].join('\n');
}

function localeTransitionSituation(
  locale: SessionPresentationLocale,
  toolName: 'SetSessionLocale' | 'set_session_locale',
): string {
  if (locale.source === 'explicit') {
    return (
      'The visitor explicitly chose this language. Keep it even when a later utterance is clearly ' +
      `in another language; conversational evidence cannot override it. Only a direct request to ` +
      `change language calls ${toolName} with explicit evidence and replaces this preference.`
    );
  }
  return (
    `The browser locale is only an initial hint. Before replying, call ${toolName} with explicit ` +
    "evidence for a direct language request, or with conversation evidence when a visitor's " +
    'complete utterance is clearly in another language even if they did not ask to switch. An ' +
    'unambiguous one-word greeting counts; length alone is not a reason to keep the current ' +
    'locale. A successful tool result is the new authority for the rest of this turn. Never ' +
    'switch for a proper noun, place, address, code, URL, an ambiguous shared token such as “OK”, ' +
    'or a mixed-language fragment.'
  );
}

function stableUiSituation(stableUi: StableUiLocalizationStatus): string {
  if (stableUi.status === 'active') {
    return 'Every attached browser acknowledges the current complete stable-UI bundle as active.';
  }
  if (stableUi.status === 'source-fallback') {
    return 'Stable UI remains in its prior complete language after source fallback; do not claim it changed.';
  }
  if (stableUi.status === 'no-browser') {
    return 'No browser is attached, so there is no stable-UI activation to claim.';
  }
  return 'Stable-UI activation is pending on at least one browser; do not claim buttons, labels, or menus changed.';
}
