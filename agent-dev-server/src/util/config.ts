import type { DependencyContainer } from '../container.ts';
import { getJWTPayload } from './jwt.ts';

export const AgentEnvs = Object.freeze({
  Preview: 'preview',
  Published: 'published',
} as const);

export type AgentEnv = (typeof AgentEnvs)[keyof typeof AgentEnvs];

export function getConfigId(container: DependencyContainer): string {
  const modelAccessKey = container.settings.getSecret('MODEL_ACCESS_KEY');
  const { agentId } = getJWTPayload<{ agentId: string }>(modelAccessKey);
  return agentId;
}

/**
 * Read the agent's environment from the `env` claim on `MODEL_ACCESS_KEY`.
 *
 * The platform signs this claim when it spawns the VM (`fly-dev-server.service.ts`
 * sets `env: 'preview'`, `fly-runtime-provider.ts` sets `env: 'published'`).
 * `AgentWsAuthenticator` reads the same claim to scope state — so this is the
 * single source of truth for env, matching what the state service uses.
 *
 * Throws if `MODEL_ACCESS_KEY` is missing — every agent VM is spawned with one,
 * so its absence is a platform misconfiguration, not a fallback case.
 */
export function getAgentEnv(container: DependencyContainer): AgentEnv {
  const modelAccessKey = container.settings.getSecret('MODEL_ACCESS_KEY');
  if (!modelAccessKey) {
    throw new Error('MODEL_ACCESS_KEY is required to determine agent env');
  }
  const { env } = getJWTPayload<{ env?: string }>(modelAccessKey);
  return env === AgentEnvs.Preview ? AgentEnvs.Preview : AgentEnvs.Published;
}

export function isPreview(container: DependencyContainer): boolean {
  return getAgentEnv(container) === AgentEnvs.Preview;
}
