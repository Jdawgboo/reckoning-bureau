/**
 * Where a turn came from, as a closed set.
 *
 * This used to be a free string that only the voice gateway ever set — every
 * other send path (omnibox, trigger, cron, HTTP) left it undefined. Any rule
 * written against it was therefore a voice special case, which is the shape to
 * avoid: the question the agent actually needs answered is not "was this
 * voice?" but "does this caller have a screen, and did they ask to change it?"
 */
export const TURN_CHANNELS = [
  'omnibox',
  'chat',
  'voice',
  'screen',
  'http',
  'mcp',
  'trigger',
  'cron',
  'phone',
] as const;

export type TurnChannel = (typeof TURN_CHANNELS)[number];

const KNOWN: ReadonlySet<string> = new Set(TURN_CHANNELS);

/**
 * The channel a send path tagged, or `undefined` when it tagged nothing (or
 * something unrecognised). Deliberately NOT defaulted: guessing "omnibox" would
 * label a cron run as a visitor sitting at a screen, and everything downstream
 * would believe it.
 */
export function resolveTurnChannel(
  metadata: Record<string, unknown> | undefined,
): TurnChannel | undefined {
  const channel = metadata?.channel;
  return typeof channel === 'string' && KNOWN.has(channel) ? (channel as TurnChannel) : undefined;
}

/**
 * Whether a live screen is in front of someone. Unknown counts as **no**: a
 * caller that never identified itself is treated as screenless, which is the
 * conservative direction — it withholds screen-shaped behaviour rather than
 * inventing an audience that may not exist.
 *
 * `'phone'` is deliberately absent from the true list, and it is the one
 * channel where that is a product decision rather than a technical one: the
 * caller is a person in a live conversation, but they hear words and see
 * nothing. Stating it here keeps the fall-through from reading like an
 * oversight — a phone turn must never be given screen-shaped behaviour.
 */
export function channelHasLiveScreen(channel: TurnChannel | undefined): boolean {
  return channel === 'omnibox' || channel === 'chat' || channel === 'voice' || channel === 'screen';
}
