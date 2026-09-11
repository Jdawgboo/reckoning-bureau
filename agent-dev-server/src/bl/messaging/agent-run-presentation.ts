import type { KernelModelMiddleware } from '../../../vendor/agent-library/kernel/middlewares/types.ts';
import type { StateTree } from '../agent/agent-library.ts';
import { channelHasLiveScreen, type TurnChannel } from '../../ws/resolve-turn-channel.ts';
import { formatSessionLocaleSituation, formatTurnSituation } from './turn-situation.ts';
import { readUiStateBlock } from './ui-state-injection.ts';
import { createUiStateMiddleware } from './ui-state-middleware.ts';
import type { SessionLocaleRuntime } from './session-locale-runtime.ts';

/**
 * Trusted per-run presentation authority. Screen context and UI effects are
 * separate because renderer-less channels may still intentionally emit a
 * markdown-backed surface, while a phone call must do neither.
 */
export interface AgentRunPresentationCapability {
  screenContext: 'live' | 'absent';
  uiEffects: 'allowed' | 'forbidden';
}

export const DEFAULT_AGENT_RUN_PRESENTATION: AgentRunPresentationCapability = {
  screenContext: 'live',
  uiEffects: 'allowed',
};

export const SCREENLESS_AGENT_RUN_PRESENTATION: AgentRunPresentationCapability = {
  screenContext: 'absent',
  uiEffects: 'forbidden',
};

/** Conservative default for non-WS run drivers; surface output remains a
 * valid record projection even when no live renderer is attached. */
export function agentRunPresentationForChannel(
  channel: TurnChannel | undefined,
): AgentRunPresentationCapability {
  return {
    screenContext: channelHasLiveScreen(channel) ? 'live' : 'absent',
    uiEffects: 'allowed',
  };
}

export function createAgentRunPresentationMiddlewares(params: {
  capability: AgentRunPresentationCapability;
  stateTree: StateTree | null;
  sessionKey?: string;
  channel: TurnChannel | undefined;
  sessionLocale?: SessionLocaleRuntime;
}): KernelModelMiddleware[] {
  const middlewares: KernelModelMiddleware[] = [];
  if (params.capability.screenContext === 'live') {
    middlewares.push(
      createUiStateMiddleware(() => readUiStateBlock(params.stateTree, params.sessionKey)),
    );
  }
  middlewares.push(
    createUiStateMiddleware(async () => formatTurnSituation(params.channel, params.capability)),
  );
  const localeMiddleware = createSessionLocaleMiddleware(params.sessionLocale);
  if (localeMiddleware) {
    middlewares.push(localeMiddleware);
  }
  return middlewares;
}

export function createSessionLocaleMiddleware(
  sessionLocale: SessionLocaleRuntime | undefined,
): KernelModelMiddleware | null {
  if (!sessionLocale) {
    return null;
  }
  return createUiStateMiddleware(async () => {
    const locale = sessionLocale.current();
    return formatSessionLocaleSituation(locale, sessionLocale.stableUi(locale));
  });
}
