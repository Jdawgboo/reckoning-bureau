/**
 * The VM half of the realtime-relay wire contract.
 *
 * The AGENT selects its voice model — `AGENT_CONFIG.voice.model`, resolved
 * through `voiceRealtimeModel` in `bl/config-bridge.ts`, exactly as
 * `AGENT_CONFIG.modelId` selects the orchestrator. This URL carries that
 * choice. The platform relay never picks a model: it admits the id, ROUTES it
 * to an upstream (OpenAI Realtime, Gemini Live, or Amazon Nova Sonic), holds
 * the provider CREDENTIALS, GATES credits, and METERS the session. A VM still
 * holds no provider key — only its model-access token.
 *
 * Wire: `wss://<platform>/api/gateway/realtime?model=<id>&channel=phone|voice&token=<key>`
 *
 * `channel=` is observability only — it lets platform logs separate call
 * traffic from browser voice. `model=` is the authoritative selector.
 */

/** Which surface is dialling: the browser voice widget, or a phone call. */
export type VoiceRelayChannel = 'voice' | 'phone';

/**
 * Builds the relay URL for one session. `baseUrl` is the platform HTTP origin
 * the runtime was handed (`http(s)://…`), rewritten to the WebSocket scheme.
 */
export function buildRelayUrl(params: {
  baseUrl: string;
  accessKey: string;
  channel: VoiceRelayChannel;
  model: string;
}): string {
  const wsBase = params.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  const model = encodeURIComponent(params.model);
  const token = encodeURIComponent(params.accessKey);
  return `${wsBase}/api/gateway/realtime?model=${model}&channel=${params.channel}&token=${token}`;
}
