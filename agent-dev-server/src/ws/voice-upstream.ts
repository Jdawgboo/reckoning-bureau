/**
 * Which provider adapter a voice session runs, given the model this agent chose.
 *
 * The relay this runtime dials is an authenticated PROXY, not a translator: it
 * routes the model, attaches the provider credential the runtime must not hold,
 * and passes frames through untouched. So the protocol on the wire is the chosen
 * provider's own, and the adapter that speaks it runs HERE. Picking the wrong one
 * is not a degraded session — it is a session that connects, sends a frame the
 * provider does not recognise, and is closed without a word being spoken.
 *
 * The model id is the only input. `voiceRealtimeModel` in `bl/config-bridge.ts`
 * resolves it from `AGENT_CONFIG.voice.model`, and the classifier that maps it to
 * a provider is the shared one — the same function the relay admits the
 * connection with, so the two ends can never disagree about what an id means.
 *
 * An id no adapter serves is refused, loudly, naming the id. Never a fallback to
 * whichever provider happens to be first: the agent's owner would be billed for a
 * model nobody chose, and nothing on either end would say so.
 *
 * ## One connection per session
 *
 * `connect` must open a NEW relay socket every time it is called. Every provider
 * caps a single connection well below the length of an ordinary conversation, so
 * a long session is several connections in sequence, and each one carries exactly
 * one provider session. Handing back one already-open socket would put the
 * replacement session on the connection it was meant to replace.
 */
import type { RealtimeSocket } from '../../vendor/agentplace-voice/openai-realtime-socket.ts';
import { OpenAiRealtimeUpstream } from '../../vendor/agentplace-voice/openai-realtime-upstream.ts';
import { GeminiLiveUpstream } from '../../vendor/agentplace-voice/gemini-live-upstream.ts';
import { NovaSonicUpstream } from '../../vendor/agentplace-voice/nova-sonic-upstream.ts';
import { novaStreamOverSocket } from '../../vendor/agentplace-voice/nova-socket-stream.ts';
import {
  classifyRealtimeModel,
  SERVABLE_REALTIME_MODEL_HINT,
  type RealtimeUpstreamKind,
} from '../../vendor/agentplace-voice/realtime-model-routing.ts';
import type { RealtimeUpstream } from '../../vendor/agentplace-voice/realtime-upstream.ts';
import type { RealtimeCapabilities } from '../../vendor/agentplace-voice/realtime-upstream.ts';

/**
 * WebSocket close code for "the configured voice model cannot be served".
 *
 * The same code the platform relay uses to refuse the identical condition, so a
 * refusal reads the same whichever end noticed it first. It is deliberately not
 * one of the generic codes: 1011 would report a server fault, and this is a
 * configuration the agent's owner can fix.
 */
export const VOICE_MODEL_UNSERVABLE_CLOSE_CODE = 4004;

/** The configured voice model names no provider this runtime can speak to. */
export class VoiceModelUnservableError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      `'${model}' is not a realtime voice model this agent can use. ${SERVABLE_REALTIME_MODEL_HINT}`,
    );
    this.name = 'VoiceModelUnservableError';
    this.model = model;
  }
}

/** A provider adapter, with the routing decision that chose it. */
export interface RelayVoiceUpstream {
  /** Ready to hand to a session manager; opens a connection per session. */
  upstream: RealtimeUpstream;
  kind: RealtimeUpstreamKind;
}

export type VoiceLocaleProjection = 'per-response' | 'live-context' | 'next-connection';

export function voiceLocaleProjection(capabilities: RealtimeCapabilities): VoiceLocaleProjection {
  if (capabilities.perResponseInstructions) {
    return 'per-response';
  }
  if (capabilities.mutableConversation) {
    return 'live-context';
  }
  return 'next-connection';
}

/**
 * The adapter for a model id, or a {@link VoiceModelUnservableError} naming the id.
 *
 * Separated from the dial so a misconfigured model is reported before any session
 * state exists, rather than as an unexplained silence on the first request.
 */
export function createRelayVoiceUpstream(params: {
  model: string;
  /** Opens ONE relay socket. Called again for each connection a long session needs. */
  connect: () => Promise<RealtimeSocket>;
}): RelayVoiceUpstream {
  const { model, connect } = params;
  const kind = classifyRealtimeModel(model);
  if (!kind) {
    throw new VoiceModelUnservableError(model);
  }
  if (kind === 'gemini') {
    return { upstream: geminiUpstream(model, connect), kind };
  }
  if (kind === 'nova') {
    return { upstream: novaUpstream(connect), kind };
  }
  return { upstream: new OpenAiRealtimeUpstream({ connect }), kind };
}

/**
 * Vertex names a model by a full publisher resource path that embeds a Google
 * project — a value this runtime deliberately does not hold. So the bare id goes
 * out in the configuration frame and the relay replaces that one field with the
 * path on the way past. The adapter never learns the difference.
 */
function geminiUpstream(model: string, connect: () => Promise<RealtimeSocket>): RealtimeUpstream {
  return new GeminiLiveUpstream({ connect, modelResource: model });
}

/**
 * Nova alone is not a WebSocket at the provider: it is a bidirectional HTTP/2
 * stream, which is why the relay terminates this runtime's socket and
 * re-originates the call rather than proxying frames blindly. Nova's own frames
 * still cross that socket unchanged, one JSON object per message, so the adapter
 * is handed the socket presented as the stream port it expects.
 */
function novaUpstream(connect: () => Promise<RealtimeSocket>): RealtimeUpstream {
  return new NovaSonicUpstream({
    connect: async () => novaStreamOverSocket(await connect()),
  });
}
