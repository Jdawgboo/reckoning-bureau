/**
 * This agent's config anchor: identity-level choices the builder makes.
 * Builder-editable. `modelId` is required — there is no platform fallback;
 * the remaining fields are optional. Platform code reads this ONLY through
 * `bl/config-bridge.ts` (the sanctioned seam — see zone-boundary.test.ts).
 */
export interface AgentVoiceConfig {
  /** 'realtime' enables the voice gateway; 'v0' keeps record-and-transcribe. */
  engine: 'realtime' | 'v0';
  /**
   * The realtime voice model this agent answers with — the voice twin of
   * {@link AgentConfig.modelId}. You never supply a provider key for it; voice
   * minutes are billed to this agent's account like any other model call.
   *
   * Leave it unset and each surface answers on the model that suits it — the
   * browser voice control uses `'gpt-realtime-2.1'`, the flagship, since it
   * shares a screen with the visitor, and a phone leg answers on the platform
   * default for calls. Naming one here uses it on every surface; there is no
   * per-surface field, so an agent that names a model uses it for calls and for
   * browser voice alike.
   *
   * Four ids cover every sensible choice:
   *
   * - `'gpt-realtime-2.1'` — the most capable voice, and the only family that
   *   can be handed an exact line to say or be cut off mid-sentence when the
   *   visitor talks over it.
   * - `'gpt-realtime-2.1-mini'` — roughly a third the audio cost at the same
   *   conversation quality; the one to name when call volume is the constraint.
   * - `'gemini-live-2.5-flash-native-audio'` — the cheapest per spoken minute.
   *   A connection lasts about ten minutes and longer calls are stitched
   *   together automatically, and text handed to the voice is followed as
   *   direction rather than read out word for word.
   * - `'amazon.nova-2-sonic-v1:0'` — an eight-minute connection, likewise
   *   stitched. Its conversation is fixed when the session opens, so it never
   *   learns what the agent put on screen mid-call, and it cannot be given
   *   exact wording either.
   *
   * Earlier OpenAI releases (`'gpt-realtime'`, `'gpt-realtime-1.5'`,
   * `'gpt-realtime-2'`) still answer as well.
   *
   * An id this platform does not serve is refused when the session opens,
   * naming the id — a session is never quietly served by a model you did not
   * choose.
   */
  model?: string;
  /** Monthly cap in realtime minutes; sessions refuse politely past it. */
  monthlyMinutesCap?: number;
}

export interface AgentConfig {
  modelId: string;
  localization: {
    /** Language used by FormatJS descriptor default messages. */
    sourceLocale: string;
  };
  voice?: AgentVoiceConfig;
}

export const AGENT_CONFIG: AgentConfig = {
  modelId: 'openai.gpt-5.6-terra',
  localization: { sourceLocale: 'en' },
  voice: { engine: 'realtime' },
};
