/**
 * The ONE platform seam onto the agent's config anchor (`src/config.ts`).
 * Platform modules import THIS, never the anchor — enforced by
 * zone-boundary.test.ts. Keeps "builder edits config.ts" from creating
 * scattered platform→agent import edges.
 */
import { AGENT_CONFIG, type AgentConfig } from '../config.ts';
import type { VoiceRelayChannel } from '../ws/voice-relay-url.ts';

export function agentConfig(): AgentConfig {
  return AGENT_CONFIG;
}

/**
 * The agent's orchestrator model id. Throws when the anchor is missing or
 * blank — types are erased at runtime, so this guard is the only enforcement.
 */
export function agentModelId(): string {
  return requireModelId(AGENT_CONFIG.modelId);
}

export function requireModelId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'AGENT_CONFIG.modelId is not set. Set modelId in agent-dev-server/src/config.ts',
    );
  }
  return value.trim();
}

/**
 * Default realtime model for a CALL, used when the agent names none. Mini by
 * default: the same conversation quality at ~1/3 the per-call cost.
 *
 * These two constants are the ONLY home of the per-channel voice defaults. The
 * platform relay deliberately holds no per-channel policy — it routes whatever
 * id arrives — so nothing on the server mirrors them. Changing one here changes
 * what every agent that names no model dials, with no platform deploy.
 */
export const DEFAULT_PHONE_VOICE_MODEL = 'gpt-realtime-2.1-mini';

/** Default for browser voice: the flagship, since it shares a screen with the
 *  visitor. See {@link DEFAULT_PHONE_VOICE_MODEL} for where these live and why. */
export const DEFAULT_BROWSER_VOICE_MODEL = 'gpt-realtime-2.1';

/**
 * The realtime voice model this session runs on: the AGENT's own choice
 * (`AGENT_CONFIG.voice.model`), else the platform default for the channel that
 * is calling. The VM sends the result to the relay, which routes, gates, and
 * meters it but never selects it.
 */
export function voiceRealtimeModel(channel: VoiceRelayChannel): string {
  return resolveVoiceModel(AGENT_CONFIG.voice?.model, channel);
}

/**
 * The rule behind {@link voiceRealtimeModel}, separated from the anchor read so
 * both arms are testable — same split as `requireModelId` / `agentModelId`.
 *
 * Truthiness, not `??`: a builder leaving the field blank means "unset", not
 * "dial an empty model", and types are erased at runtime so a non-string is a
 * reachable state.
 */
export function resolveVoiceModel(configured: unknown, channel: VoiceRelayChannel): string {
  const chosen = typeof configured === 'string' ? configured.trim() : '';
  if (chosen) {
    return chosen;
  }
  return channel === 'phone' ? DEFAULT_PHONE_VOICE_MODEL : DEFAULT_BROWSER_VOICE_MODEL;
}

/**
 * The agent owner's contact for notifications. Owner identity is PLATFORM
 * truth (the account behind the agent) — delivered at provisioning, never
 * builder-typed config. Until platform-delivered runtime config lands
 * (Phase-1 spec §6.5), the env var is the provisioning stand-in.
 */
export function ownerContact(): { email: string } | null {
  const email = process.env.AGENT_OWNER_EMAIL;
  return email ? { email } : null;
}
