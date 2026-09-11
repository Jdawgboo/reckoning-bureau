/**
 * Which upstream a realtime model id selects — the single answer, shared by
 * every surface that has to route one.
 *
 * There are three such surfaces (an agent runtime dialling through a relay, the
 * relay admitting what it dialled, and a platform-owned voice session dialling a
 * provider directly), and they must agree exactly. A second copy of these
 * patterns is not a duplicated helper, it is a routing bug waiting to happen:
 * one surface admitting an id the next one refuses shows up as a session that
 * connects and then dies with nothing said.
 *
 * The rules only ever *recognise*. Nothing here defaults, falls back, or
 * substitutes: an unrecognised id is `null`, and it is the caller's job to refuse
 * loudly. A silent fallback would bill whoever chose the model for a provider
 * nobody picked, and the substitution would be invisible on both ends.
 */

import { NOVA_2_SONIC_MODEL } from './nova-sonic-upstream.ts';

/** Which upstream serves a model id. */
export type RealtimeUpstreamKind = 'openai' | 'gemini' | 'nova';

const OPENAI_MODEL_PATTERN = /^gpt-realtime[\w.-]*$/;

/**
 * Gemini Live model ids, e.g. `gemini-live-2.5-flash-native-audio` (Vertex) and
 * `gemini-3.1-flash-live-preview` — `live` can sit anywhere after the family
 * prefix, so match on its presence rather than on a position.
 */
const GEMINI_LIVE_MODEL_PATTERN = /^gemini-[\w.-]*live[\w.-]*$/;

/**
 * One servable id per upstream, named in a refusal so whoever chose the rejected
 * one can see what a working choice looks like. Shared, so every surface's
 * complaint names the same three rather than three subtly different lists.
 *
 * Examples, not the whole set: the OpenAI and Gemini families are matched by
 * pattern, so an exhaustive list is not something this module can produce.
 */
export const SERVABLE_REALTIME_MODEL_EXAMPLES: readonly string[] = Object.freeze([
  'gpt-realtime-2.1',
  'gemini-live-2.5-flash-native-audio',
  NOVA_2_SONIC_MODEL,
]);

/** {@link SERVABLE_REALTIME_MODEL_EXAMPLES} as one clause for an error message. */
export const SERVABLE_REALTIME_MODEL_HINT = `Supported ids include: ${SERVABLE_REALTIME_MODEL_EXAMPLES.join(', ')}.`;

/**
 * The one Nova id this platform serves over the bidirectional stream. Exact
 * equality matters because `amazon.nova-*` also names unsupported Sonic
 * generations plus text and vision models this transport does not serve.
 */
export function isNovaSonicModel(model: string): boolean {
  return model === NOVA_2_SONIC_MODEL;
}

/**
 * Which upstream serves this model id, or null when none does — including for
 * the empty string, which is refused rather than defaulted.
 */
export function classifyRealtimeModel(model: string): RealtimeUpstreamKind | null {
  if (OPENAI_MODEL_PATTERN.test(model)) {
    return 'openai';
  }
  if (GEMINI_LIVE_MODEL_PATTERN.test(model)) {
    return 'gemini';
  }
  if (isNovaSonicModel(model)) {
    return 'nova';
  }
  return null;
}
