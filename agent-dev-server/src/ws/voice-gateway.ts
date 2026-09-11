/**
 * WebSocket ingress for deployed realtime voice sessions: same trust model as
 * `/ws` (gateway-injected identity headers + `agent_session_id` query), resolves
 * the session, dials the platform relay for the model THIS AGENT chose
 * (`AGENT_CONFIG.voice`, read through `voiceRealtimeModel`, routed and metered
 * by the relay but never selected by it — see `voice-relay-url.ts`), and hands
 * the connection to a {@link DeployedVoiceAttachment}.
 *
 * The split is deliberate: this file owns authentication, wire framing,
 * connection lifecycle and telemetry; the attachment owns context handoff,
 * screen projection, run delegation, speech, activation and history mapping.
 * Neither writes durable storage directly.
 *
 * Voice is another INPUT to the one session — a spoken request becomes a normal
 * agent turn that renders to the stage while the attachment speaks progress.
 *
 * The same endpoint answers real calls. A call bridge sets the call headers
 * that `resolveCallContext` reads, taking the phone arm of `resolveCallProfile`
 * — phone persona, fresh request-scoped session, always greet, no screen
 * anywhere, and `channel: 'phone'` on every forwarded turn. `?phone_sim=1`
 * drives the same arm from a browser, minus the transport.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { VoiceClientLink } from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import { ACTIVE_RUN_LIVENESS_INSTRUCTIONS } from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import {
  createBrowserPcm24DeliveryPolicy,
  createPcm24AudioConfig,
} from '../../vendor/agentplace-voice/delivery-policy.ts';
import { connectRealtime } from '../../vendor/agentplace-voice/openai-realtime-socket.ts';
import { withSessionRotation } from '../../vendor/agentplace-voice/rotating-upstream-session.ts';
import { agentConfig, voiceRealtimeModel } from '../bl/config-bridge.ts';
import { extractSessionIdentity } from '../sdk/session-id.ts';
import { describeAdmissionFailure } from './session-admission.ts';
import { isRecord, isMemoryEntryArray } from '../util/type-guards.ts';
import { acceptUpgrade, upgradeSearchParams } from '../util/ws-upgrade.ts';
import { log } from '../util/logger.ts';
import type { MessageProcessor } from './message-processor.ts';
import type { WsSessionManager } from './session-manager.ts';
import {
  DEPLOYED_VOICE_VOCABULARY,
  composeRoleTools,
  createLocaleRoleTools,
  createMemoryRoleTools,
} from './voice-tools.ts';
import { memoryBankSection, type CapabilityCard } from './voice-narration.ts';
import { createAttachmentVoiceScreenSource } from './voice-screen.ts';
import { buildRelayUrl, type VoiceRelayChannel } from './voice-relay-url.ts';
import {
  VOICE_MODEL_UNSERVABLE_CLOSE_CODE,
  VoiceModelUnservableError,
  createRelayVoiceUpstream,
  type RelayVoiceUpstream,
  voiceLocaleProjection,
} from './voice-upstream.ts';
import type { VoiceConversationHistory } from './voice-session-history.ts';
import type { VoiceUsageMeter } from './voice-usage.ts';
import { DeployedVoiceAttachment, type DeployedVoiceProfile } from './deployed-voice-attachment.ts';
import {
  DEFAULT_AGENT_RUN_PRESENTATION,
  SCREENLESS_AGENT_RUN_PRESENTATION,
} from '../bl/messaging/agent-run-presentation.ts';
import {
  resolveCallContext,
  resolveCallProfile,
  resolveVoiceSessionIdentity,
} from './call-profile.ts';
import { PhoneLatencyTracker } from './phone-latency.ts';
import type { SessionLocalizationService } from './session-localization.service.ts';
import { formatVoiceLocaleSituation } from '../bl/messaging/turn-situation.ts';
import {
  serverMessages,
  type ServerMessageDescriptor,
  voiceClientMessage,
} from '../services/server-localization-messages.ts';
import type { AgentSession } from './agent-session.ts';

const DEPLOYED_VOICE_INSTRUCTIONS = `You are the realtime spoken interface of the active agent in this conversation. The visitor is talking to the same agent through voice, text, and the screen. Speak in that agent's first-person voice, never as a separate assistant. Warm, brief, natural. Never invent or state a self-name from platform metadata or technical identifiers.

You may always answer these yourself:
- Greetings, chitchat, and acknowledgments.
- Questions about your voice itself — your accent, how you sound, speaking speed or volume. Answer in one friendly line; these are never about the business.
- Collecting details the request needs (service, day, name) BEFORE calling handle_request once.
- When the visitor shares something lasting about themselves (a preference, a goal, who they are), call remember_this with one short sentence — then continue naturally, never announce that you saved it.
- What is (or is not) on their screen right now — answer from the CURRENT SCREEN block in your context, including when it says nothing is up yet. That block lists each field, whether it is filled, and the options available, so you can name them: "the date is still blank", "the second option is eleven o'clock". Refer to what is there rather than describing the screen in general. A field shown as (hidden) exists but must never be read aloud. NEVER use handle_request for a question about what is already displayed: asking about a screen must never change it.

When the visitor merely greets you ("hi", "hello", "hey"), do NOT call any tool — reply with one short, natural line and invite the next step. Vary your phrasing every time; never reuse a stock greeting.

Requests to show, see, or open something NEW use handle_request. Questions about who the agent is, what it represents, or what it can do also use handle_request unless the answer is explicit in delivered conversation or the CURRENT SCREEN. Never infer a self-name. Stable voice and screen attachment affordances are answered locally. Current business or product feasibility, policy, freshness, and actions use handle_request. You never render the screen yourself; use the result when it arrives. NEVER say something can't be shown or done: what's possible is the agent's fact, not yours — use handle_request and let the reply answer.

Before handle_request returns, a preamble may acknowledge only that you heard the request. Do not claim acceptance, feasibility, refusal, completion, or a particular result. The handle_request result establishes admission; the run result establishes what happened. Stable voice and screen attachment affordances are answered from this profile. Current business or product feasibility, policy, freshness, and actions use handle_request. A prior capability decision or refusal is a historical fact about that attempt, not current policy. Explain it only in the past tense and attribute it to that attempt; retry present questions and requests.

What you know and may use freely: everything already said in THIS conversation
(including the delivered-answer notes in your context) and whatever the CURRENT
SCREEN description says — the visitor already has all of it. Prior feasibility or policy
outcomes are historical facts about their attempts, not present-tense policy. Explain them
only in the past tense and attribute them to that attempt. For a read-only question
about an explicit visible value, answer locally and attribute it to the display ("it is
shown as …"). Repeat, rephrase, or point to delivered information naturally.

Use handle_request when the visitor asks whether a visible or previously
delivered fact is still current, when the answer depends on live business state not
shown in context, or when the request acts on the world (availability checks, bookings,
changes, cancellations). A noun such as "price" does not decide routing: an observed
display value is local; a freshness claim or action uses handle_request.

Not seen in this conversation: try recall_conversation first for earlier parts of
this session; otherwise use handle_request. Never answer business facts from general knowledge.
- "How is it going?" → call get_session_status.
- "Stop" / "cancel" / "wait, no" → call abort_current_run. To change course: abort_current_run, then use handle_request for the new instruction.
- "Try again" → use handle_request for the previous request again.
- When something on the visitor's screen is waiting (a form, a choice) and they respond to it BY VOICE — giving values, picking an option, or asking to fill, change, or update it — call answer_pending_action with exactly what they said. Voice is a full substitute for tapping and typing; NEVER tell the visitor to do it themselves.
- When the visitor says goodbye or asks to stop talking, call end_voice_session; your farewell comes after it returns.

Strict rules:
- When calling handle_request, a preamble is optional. If you use one, acknowledge only that you heard the request, naturally and briefly; do not announce internal work or repeat the request back.
- Use the actual prior conversation, including what you already said, to avoid repeating either information or wording. Do not rely on recurring stock acknowledgments, transitions, or status lines; express only what is new for this moment.
- Never mention tools, internal actors, systems, routing, or any internal mechanics. The visitor must never learn how you work inside. There is exactly ONE product voice.
- Be honest about COMPLETION, not ownership: the visitor may use the screen OR just tell you. Route voice requests about it. Only the handle_request result establishes whether the request was admitted; only the run result establishes feasibility and completion.
- The SESSION LOCALE block is authoritative. For a direct language request, call set_session_locale with explicit evidence before replying. When its authority is not explicit and the visitor's complete utterance is clearly in another language, call it with conversation evidence before replying even if they did not ask to switch. An explicit visitor choice stays locked until another direct language request replaces it. An unambiguous one-word greeting counts when no explicit choice is locked; length alone is not a reason to keep an automatically selected locale. Never switch because of a name, place, address, code, URL, an ambiguous shared token such as “OK”, or a mixed-language fragment.
- When something appears on the screen, speak its content or its single takeaway — never narrate the act of showing. No "look at the screen", "as you can see", "it's on your screen now": the screen is already in front of them, so pointing at it adds nothing.
- Write like a person, not a press release: plain punctuation only. Never use em or en dashes (—, –) in anything you write; use a comma, a period, or a new sentence instead.
- Speak at a natural, lively conversational pace with normal energy — never rushed, but never sluggish, drawn out, or low. Keep every reply to ONE short sentence — two only when truly necessary. Prefer fewer words; never pad with pleasantries or filler.`;

/** Greeting instructions vary by what the session knows: a re-opened session
 *  with history gets a brief welcome-back instead of a cold open. */
/**
 * The `greet` field on `voice.activate` is the browser's own first-open-of-a-
 * page-load fact and overrides the connect-time default; an older browser
 * without the field keeps whatever the connection resolved.
 */
/** The rejected selection's identity for the log — ids only, never screen content. */
function describeScreenSelection(selection: unknown): string {
  if (selection === null) {
    return 'null';
  }
  if (!isRecord(selection)) {
    return typeof selection;
  }
  const kind = typeof selection['kind'] === 'string' ? selection['kind'] : 'unknown';
  const surfaceId = typeof selection['surfaceId'] === 'string' ? selection['surfaceId'] : '';
  const messageId = typeof selection['messageId'] === 'string' ? selection['messageId'] : '';
  return `${kind} surface=${surfaceId} message=${messageId}`;
}

export function activationSpeakFirst(event: Record<string, unknown>, fallback: boolean): boolean {
  const greet = event['greet'];
  return typeof greet === 'boolean' ? greet : fallback;
}

function deployedGreetingInstructions(params: { hasHistory: boolean }): string {
  const { hasHistory } = params;
  const opener =
    'Give ONE short opener sentence in your own words, first person — greet the visitor warmly';
  const invitation = hasHistory
    ? 'and briefly welcome them back — do not restart or summarize the conversation, just invite them to continue.'
    : 'and invite their question or request.';
  return `${opener} ${invitation} Never reference tools, systems, or past topics. Never mention any visitor detail beyond their name unless they bring it up. Phrase it differently every session; avoid canned lines.`;
}

const DEPLOYED_ADMISSION_INSTRUCTIONS = `The work has started. In the active agent's first-person voice, give one brief, natural acknowledgement that work started based only on the fact below. Do not describe another actor or internal routing, repeat the request, or reuse an acknowledgement already heard.

Admission: `;

const DEPLOYED_PROGRESS_INSTRUCTIONS = `Convey the confirmed progress fact below in one short, natural sentence in the active agent's first-person voice. Preserve its meaning and exact quantities, but author the wording from the conversation instead of reciting the fact. Do not infer another step, result, or screen change. Avoid repeating wording or sentence patterns already heard.

Progress fact: `;

const DEPLOYED_RELAY_INSTRUCTIONS = `Tell the visitor in the active agent's first-person voice: Summarize only its single most important point aloud in ONE short sentence (two only if truly essential), in your own words — never verbatim, no lists, no technical identifiers. If something on their screen needs them (a form, a choice), tell them it's ready — they can use it directly or just tell you; never claim it is already filled or done before it is. Do NOT ask a follow-up question unless the result genuinely requires the visitor to decide something.

Result: `;

export interface VoiceGatewayOptions {
  sessionManager: WsSessionManager;
  messageProcessor: MessageProcessor;
  /** Platform realtime relay — the VM never holds a provider key; it dials the
   *  platform's WS relay with its model-access key, the model this agent chose,
   *  and the channel it is serving (`buildRelayUrl`), and the platform routes
   *  that model to an upstream, holds the provider credentials, and accounts
   *  the credits (same trust model as the HTTP model gateway). */
  relay: { baseUrl: string; accessKey: string } | undefined;
  usageMeter: VoiceUsageMeter;
  /** This agent's render surfaces, from `ToolRegistryFactory.getCapabilityCard()`
   *  (the sanctioned seam onto `src/surfaces/` — see `zone-boundary.test.ts`).
   *  Fed into the voice grounding so the model knows what forwarding a
   *  request can put on the visitor's screen instead of guessing. */
  capabilities: CapabilityCard[];
  /** Durable session history for spoken turns. A session that cannot record
   *  what was said is refused rather than run without continuity. */
  sessionHistory?: VoiceConversationHistory;
  localizationService: SessionLocalizationService;
  /** Session-end blackboard write: the voice conversation becomes an
   *  `interactions` record like any other visitor outcome. Fire-and-forget;
   *  absent in tests. */
  logInteraction?: (row: {
    sessionKey: string;
    kind: 'voice-session';
    summary: string;
    durationMs: number;
  }) => Promise<void>;
}

export class VoiceGateway {
  readonly path = '/voice';
  #wss: WebSocketServer;
  #options: VoiceGatewayOptions;

  constructor(options: VoiceGatewayOptions) {
    this.#options = options;
    this.#wss = new WebSocketServer({ noServer: true });
    this.#wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.#handleConnection(ws, req).catch((error) => {
        // Voice resolves `agent_session_id` the same way `/ws` does and shares
        // `getOrCreate`, so it can be refused the same way. Reporting that as a
        // 1011 server failure would be wrong and unactionable.
        const refusal = describeAdmissionFailure(error);
        if (refusal) {
          log('warn', { event: 'voice.connection.refused', reason: refusal.reason });
          ws.close(refusal.code, refusal.reason);
          return;
        }
        log('error', {
          event: 'voice.connection.error',
          error: error instanceof Error ? error.message : String(error),
        });
        ws.close(1011, 'voice session failed');
      });
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    acceptUpgrade(this.#wss, { req, socket, head }, '/voice', (ws) =>
      this.#wss.emit('connection', ws, req),
    );
  }

  shutdown(): void {
    this.#wss.close();
  }

  async #handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Everything below happens before the client's first frame is even read —
    // it is parked until the attachment exists — so on a call this is the
    // caller sitting on an answered line. Timed leg by leg, because "set-up"
    // as a single number says only that it was slow, never which await it was.
    const setup = new VoiceSetupTimings();
    let attachment: DeployedVoiceAttachment | null = null;
    let handleAttachmentEvent: ((event: Record<string, unknown>) => void) | null = null;
    let pendingInitializationEvent: Record<string, unknown> | null = null;
    const client: VoiceClientLink = {
      send: (event) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      },
      // Session setup awaits a relay dial and a provider round trip, so a
      // visitor who leaves during it is ordinary rather than rare: a handler
      // registered after the socket closed must still run its teardown.
      onClose: (handler) => {
        if (ws.readyState === ws.CLOSED) {
          handler();
          return;
        }
        ws.on('close', handler);
      },
      close: () => ws.close(1000, 'session ended'),
    };
    ws.on('message', (raw) => {
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!isRecord(parsed)) {
          return;
        }
        if (handleAttachmentEvent) {
          handleAttachmentEvent(parsed);
          return;
        }
        if (parsed['type'] === 'voice.initialize' && !pendingInitializationEvent) {
          pendingInitializationEvent = parsed;
          return;
        }
        log('warn', {
          event: 'voice.attachment.dropped_before_ready',
          type: typeof parsed['type'] === 'string' ? parsed['type'] : 'unknown',
        });
      } catch {
        log('warn', { event: 'voice.attachment.unparseable' });
      }
    });

    const query = upgradeSearchParams(req);
    const identity = extractSessionIdentity(req);
    // Everything that differs between a browser visitor and a caller, decided
    // once. A call bridge announces itself with handshake headers that also
    // carry the caller's number when it knows one; `?phone_sim=1` is the
    // browser-driven way into the same arm.
    const callContext = resolveCallContext({ query, headers: req.headers });
    const callProfile = resolveCallProfile({
      context: callContext,
      voice: {
        instructions: DEPLOYED_VOICE_INSTRUCTIONS,
        greetingInstructions: deployedGreetingInstructions,
      },
    });
    // Browser voice follows the selected browser session. A phone attachment
    // uses only the trusted request identity: the simulator omits the browser
    // session query, while the real bridge must supply the platform-created
    // call session through its authenticated request. Caller ID never chooses
    // durable identity.
    const sessionIdentity = resolveVoiceSessionIdentity({
      channel: callProfile.channel,
      requestSessionId: identity.sessionId,
      requestUserId: identity.userId,
      requestedBrowserSessionId: query.get('agent_session_id'),
    });
    const sessionKey = sessionIdentity.sessionKey;
    const refusal = await this.#refusalReason();
    setup.mark('admission');
    if (refusal) {
      const message = this.#formatSessionMessage(
        this.#options.sessionManager.get(sessionKey),
        refusal,
      );
      log('info', { event: 'voice.refused', reason: refusal.id });
      client.send({ type: 'voice.error', message });
      ws.close(1000, 'voice unavailable');
      return;
    }
    const sessionHistory = this.#options.sessionHistory;
    if (!sessionHistory) {
      throw new Error('voice history unavailable after admission');
    }
    const session = await this.#options.sessionManager.getOrCreate(sessionKey, {
      userId: sessionIdentity.userId,
      configId: identity.configId,
    });
    setup.mark('session');
    // After session resolution, but before history or provider work.
    let dialledSocket: Awaited<ReturnType<typeof connectRealtime>> | undefined;
    const voiceUpstream = this.#resolveUpstream(
      ws,
      client,
      session,
      callProfile.channel,
      (socket) => {
        dialledSocket = socket;
      },
    );
    if (!voiceUpstream) {
      return;
    }
    // Calls only: a browser visitor's latency is already covered by the voice
    // architecture's own measurements, and a caller's is the product.
    const latency =
      callProfile.channel === 'phone' ? new PhoneLatencyTracker({ sessionKey }) : undefined;

    // What the visitor can actually see is attachment-local: the browser names
    // a surface it was rendered, and the session resolves it. Nothing the
    // browser sends becomes screen truth on its own.
    const screenSource = createAttachmentVoiceScreenSource({
      resolveSurface: (surfaceId) => session.screenForVoice(surfaceId),
    });
    const prepared = await DeployedVoiceAttachment.prepare({
      session,
      sessionHistory,
      messageProcessor: this.#options.messageProcessor,
      // The capability card lists what forwarding can put ON A SCREEN, and a
      // phone turn is built without the surface tools that would do it —
      // offering it to a caller advertises something that cannot happen.
      capabilities: callProfile.hasScreen ? this.#options.capabilities : [],
      screen: callProfile.hasScreen
        ? { kind: 'live', read: () => screenSource.read() }
        : { kind: 'absent' },
      channel: callProfile.channel,
      runPresentation: callProfile.hasScreen
        ? DEFAULT_AGENT_RUN_PRESENTATION
        : SCREENLESS_AGENT_RUN_PRESENTATION,
      formatStableMessage: (messageId, values) =>
        this.#options.localizationService.format(session.presentationLocale, messageId, values),
      resolveClientMessage: (code) => this.#formatSessionMessage(session, voiceClientMessage(code)),
      latency,
    });
    setup.mark('history');
    // Greeting policy: the browser owns "first voice open of this page load"
    // and says so — `greet` on the voice.activate message (authoritative), or
    // the legacy `greet=1` query param at connect. A client sending neither
    // falls back to greeting only a session with nothing said yet. A call
    // decides for itself: a silent line reads as a dropped call.
    const greetParam = query.get('greet');
    const browserSpeakFirst = greetParam !== null ? greetParam === '1' : !prepared.hasHistory;
    const speakFirst = callProfile.speakFirst ?? browserSpeakFirst;
    const profile: DeployedVoiceProfile = {
      instructions: [
        callProfile.instructions,
        formatVoiceLocaleSituation(session.presentationLocale),
      ].join('\n\n'),
      voice: 'marin',
      callerAudio: { noiseReduction: callProfile.audio.noiseReduction },
      // `null` follows the caller into their own language; a pinned language
      // keeps an accented telephone caller from being transcribed into another.
      callerTranscription:
        callProfile.audio.transcriptionLanguage === null
          ? {}
          : { language: callProfile.audio.transcriptionLanguage },
      speakFirst,
      busyToolNames: [DEPLOYED_VOICE_VOCABULARY.forwardName],
      // The call profile owns the greeting: the phone arm must disclose the AI
      // assistant, which browser voice deliberately does not.
      greetingInstructions: callProfile.greetingInstructions({
        hasHistory: prepared.hasHistory,
      }),
      admissionInstructions: DEPLOYED_ADMISSION_INSTRUCTIONS,
      progressInstructions: DEPLOYED_PROGRESS_INSTRUCTIONS,
      livenessInstructions: ACTIVE_RUN_LIVENESS_INSTRUCTIONS,
      relayInstructions: DEPLOYED_RELAY_INSTRUCTIONS,
    };
    try {
      const localeProjection = voiceLocaleProjection(voiceUpstream.upstream.capabilities);
      const localeRoleTools = createLocaleRoleTools({
        hasScreen: callProfile.hasScreen,
        propose: (locale, source) =>
          this.#options.localizationService.propose(session, locale, source),
        onCommitted: (locale) => {
          if (localeProjection === 'next-connection') {
            log('warn', {
              event: 'voice.locale.degraded',
              sessionKey,
              upstream: voiceUpstream.kind,
              messageLocale: locale.messageLocale,
              revision: locale.revision,
              disposition: 'next-connection',
            });
            return;
          }
          attachment?.injectContext(formatVoiceLocaleSituation(locale));
          log('info', {
            event: 'voice.locale.projected',
            sessionKey,
            upstream: voiceUpstream.kind,
            messageLocale: locale.messageLocale,
            revision: locale.revision,
            strategy: localeProjection,
          });
        },
      });
      const configured = prepared.configure(
        profile,
        composeRoleTools(createMemoryRoleTools(client), localeRoleTools),
      );
      try {
        attachment = await configured.attach({
          // Rotation rather than the adapter itself: every provider cuts a
          // single connection short of the length a conversation can reach, so
          // a session outliving its connection is infrastructure, not a
          // provider quirk. The attachment never learns it happened.
          upstream: withSessionRotation(voiceUpstream.upstream, {
            onRotation: (event) =>
              log('info', {
                event: 'voice.rotation',
                sessionKey,
                upstream: voiceUpstream.kind,
                ...event,
              }),
          }),
          client,
          deliveryPolicy: createBrowserPcm24DeliveryPolicy(),
        });
        // The relay dial lives in here, and it needs nothing the two legs above
        // produced — if this dominates, it can start alongside them.
        setup.mark('relayDial');
        if (latency && dialledSocket) {
          // Registered only AFTER attach: `onEvent` drains the startup backlog
          // destructively into the FIRST handler, so taking this seat earlier
          // would steal those frames from the RealtimeSessionManager.
          dialledSocket.onEvent((event) => {
            if (event['type'] === 'input_audio_buffer.speech_stopped') {
              latency.noteSpeechStopped();
            }
          });
        }
      } finally {
        configured.dispose();
      }
    } catch (error) {
      prepared.dispose();
      throw error;
    }
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    setup.report({ sessionKey, channel: callProfile.channel });

    let initialized = false;
    let attachmentActive = false;
    handleAttachmentEvent = (event) => {
      const type = event['type'];
      if (type === 'voice.initialize') {
        if (!initialized) {
          initialized = true;
          this.#applyMemoriesEvent(event, attachment);
          client.send({ type: 'voice.context_ready' });
        }
        return;
      }
      if (type === 'voice.activate') {
        if (initialized && !attachmentActive) {
          attachmentActive = true;
          // A call leg never carries a screen selection — the sim browser has a
          // StageView, but honouring it would diverge from a real call.
          if (callProfile.hasScreen) {
            this.#applyScreenSelection(event, screenSource, null);
          }
          attachment?.activate({
            speakFirst: callProfile.speakFirst ?? activationSpeakFirst(event, browserSpeakFirst),
          });
          client.send({ type: 'voice.active' });
        }
        return;
      }
      if (type === 'voice.screen') {
        if (callProfile.hasScreen) {
          this.#applyScreenSelection(event, screenSource, attachment);
        }
        return;
      }
      attachment?.handleAttachmentEvent(event);
    };
    if (pendingInitializationEvent) {
      handleAttachmentEvent(pendingInitializationEvent);
      pendingInitializationEvent = null;
    }

    const startedAt = Date.now();
    ws.on('close', () => {
      void this.#options.usageMeter.recordSessionMs(Date.now() - startedAt);
      const transcriptTail = attachment?.getTranscriptTail().slice(0, 2_000) ?? '';
      log('info', {
        event: 'voice.session.ended',
        sessionKey,
        durationMs: Date.now() - startedAt,
        transcriptTail,
      });
      if (transcriptTail) {
        this.#options
          .logInteraction?.({
            sessionKey,
            kind: 'voice-session',
            summary: transcriptTail,
            durationMs: Date.now() - startedAt,
          })
          .catch((error) => {
            log('warn', {
              event: 'voice.interaction-log.failed',
              sessionKey,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    });

    log('info', {
      event: 'voice.session.started',
      sessionKey,
      userId: sessionIdentity.userId,
      channel: callProfile.channel,
      hasHistory: attachment.hasHistory,
    });
  }

  /**
   * The provider adapter for the model this agent chose, or null once the session
   * has been refused.
   *
   * Refusal, never substitution: a model no adapter serves closes the socket with
   * a code and a logged reason naming the id. Quietly opening on a different
   * provider would bill the owner for a model nobody chose and leave nothing on
   * either end saying so.
   *
   * The socket is dialled lazily, once per connection the session needs — see
   * `voice-upstream.ts`. A dial failure therefore surfaces from the attachment's
   * own start, which the caller already reports.
   */
  #resolveUpstream(
    ws: WebSocket,
    client: VoiceClientLink,
    session: AgentSession,
    channel: VoiceRelayChannel,
    /**
     * Hands out each dialled socket. The caller may only SEAT a listener on it
     * after the attachment has started: `onEvent` drains the startup backlog
     * destructively into the first handler, so taking that seat earlier steals
     * those frames from the RealtimeSessionManager.
     */
    onSocket?: (socket: Awaited<ReturnType<typeof connectRealtime>>) => void,
  ): RelayVoiceUpstream | null {
    const relay = this.#options.relay;
    if (!relay) {
      throw new Error('voice relay unconfigured');
    }
    const model = voiceRealtimeModel(channel);
    const relayUrl = buildRelayUrl({
      baseUrl: relay.baseUrl,
      accessKey: relay.accessKey,
      channel,
      model,
    });
    try {
      return createRelayVoiceUpstream({
        model,
        connect: async () => {
          const socket = await connectRealtime({ url: relayUrl });
          onSocket?.(socket);
          return socket;
        },
      });
    } catch (error) {
      if (!(error instanceof VoiceModelUnservableError)) {
        throw error;
      }
      log('error', {
        event: 'voice.model.unservable',
        model: error.model,
        reason: error.message,
      });
      client.send({
        type: 'voice.error',
        message: this.#formatSessionMessage(session, serverMessages.voiceUnavailable),
      });
      ws.close(
        VOICE_MODEL_UNSERVABLE_CLOSE_CODE,
        `unsupported voice model '${error.model}'`.slice(0, 120),
      );
      return null;
    }
  }

  /**
   * `voice.initialize` is a gateway control event, never a provider
   * passthrough — it is deliberately absent from the manager's client-event
   * allowlist, so it must be intercepted here. Injected via `injectContext`
   * (the same system-role path used for connect-time grounding and armed
   * pending-action context) because the client sends this only once the
   * session is already open.
   */
  #applyMemoriesEvent(
    event: Record<string, unknown>,
    attachment: DeployedVoiceAttachment | null,
  ): void {
    const memories = event['memories'];
    if (!isMemoryEntryArray(memories) || memories.length === 0) {
      return;
    }
    attachment?.injectContext(memoryBankSection(memories));
  }

  /**
   * Records what the browser says is visible now. A new selection revokes any
   * action armed against the previous screen: the visitor navigated away from
   * the form that asked it, so answering it by voice would answer a question
   * they can no longer see.
   */
  #applyScreenSelection(
    event: Record<string, unknown>,
    screenSource: ReturnType<typeof createAttachmentVoiceScreenSource>,
    attachment: DeployedVoiceAttachment | null,
  ): void {
    const outcome = screenSource.update(event['screen']);
    if (outcome.status === 'rejected') {
      log('warn', {
        event: 'voice.screen.rejected',
        reason: outcome.reason,
        selection: describeScreenSelection(event['screen']),
      });
      return;
    }
    attachment?.clearScreenAction();
  }

  /** Polite-refusal reason, or null when the session may start. */
  async #refusalReason(): Promise<ServerMessageDescriptor | null> {
    const voice = agentConfig().voice;
    if (voice?.engine !== 'realtime') {
      return serverMessages.voiceNotEnabled;
    }
    if (!this.#options.relay) {
      return serverMessages.voiceNotConfigured;
    }
    if (!this.#options.sessionHistory) {
      return serverMessages.voiceUnavailable;
    }
    if (!(await this.#options.usageMeter.underCap(voice.monthlyMinutesCap))) {
      return serverMessages.voiceMinutesExhausted;
    }
    return null;
  }

  #formatSessionMessage(
    session: AgentSession | undefined,
    descriptor: ServerMessageDescriptor,
  ): string {
    if (!session) {
      return descriptor.defaultMessage;
    }
    return this.#options.localizationService.format(session.presentationLocale, descriptor.id);
  }
}

/**
 * How long each leg of opening a voice session took, in milliseconds.
 *
 * On a call this is the caller's silence: the connection is up, but the client's
 * first frame is parked until the attachment exists, so every await below it is
 * time on an answered line. One line per connection, always on — the same terms
 * as `phone.latency`, and for the same reason: a number nobody has to switch on
 * is the only kind that is there when the slow call happens.
 *
 * The total ends at the last leg, which is BEFORE the model provider has been
 * dialled: the platform relay accepts this connection and buffers, then
 * connects upstream. Silence outlasts this number.
 */
class VoiceSetupTimings {
  readonly #legs: Record<string, number> = {};
  readonly #startedAt = Date.now();
  #lastAt = Date.now();

  /** Closes the leg that ended here and opens the next one. */
  mark(leg: string): void {
    const now = Date.now();
    this.#legs[leg] = now - this.#lastAt;
    this.#lastAt = now;
  }

  report(context: Record<string, unknown>): void {
    log('info', {
      event: 'voice.setup.timing',
      ...context,
      ...this.#legs,
      totalMs: Date.now() - this.#startedAt,
    });
  }
}
