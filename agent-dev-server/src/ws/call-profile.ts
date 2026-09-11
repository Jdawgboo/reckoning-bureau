/**
 * What differs between a browser voice connection and a phone call, resolved
 * once at connect time so `voice-gateway.ts` reads one object instead of
 * branching on the mode at six places.
 *
 * A real telephone leg has no query string, so a call bridge announces itself
 * with handshake headers and carries the caller's number when it knows one.
 * `?phone_sim=1` reaches the same arm from a browser, driving the identical
 * presentation and profile construction minus the transport. Session identity
 * stays outside this profile; the bridge supplies a platform-created call
 * session independently.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { log } from '../util/logger.ts';
import type { TurnChannel } from './resolve-turn-channel.ts';

/** Query flag that turns a browser voice connection into a faked call. */
export const PHONE_SIM_PARAM = 'phone_sim';

/**
 * Headers describing an inbound telephone call. A telephone leg has no query
 * string, so this is how a real call announces itself.
 *
 * THE PLATFORM PUTS THEM HERE, and only for a call it recognised as one. A
 * visitor cannot become a phone caller by sending these along with a browser
 * connection, and cannot choose the number they appear to be calling from. The
 * simulator flag above is the browser-side way into the same arm; it takes the
 * telephone presentation and no caller number.
 *
 * The numbers are the telephone network's own routing information: good enough
 * to greet someone by, never good enough to prove who they are.
 */
export const CALL_CHANNEL_HEADER = 'x-agentplace-call-channel';
export const CALL_FROM_HEADER = 'x-agentplace-call-from';
export const CALL_TO_HEADER = 'x-agentplace-call-to';

/**
 * The number a simulated caller dials from. In the 555-01xx block, which is
 * reserved for fiction precisely so a test number can never reach a person.
 */
export const PHONE_SIM_CALLER = '+15550100';

/**
 * Which language the voice answers in. `caller` is the default — a session is
 * multilingual: the voice answers in whatever language it hears and switches
 * when the speaker switches. `english` is the explicit opt-out, locking both
 * personas to English regardless of what is spoken to them.
 */
export type VoiceLanguageMode = 'english' | 'caller';

const VOICE_LANGUAGE_MODES: readonly VoiceLanguageMode[] = ['english', 'caller'];

/** Multilingual by default: a business that wants an English-only line asks. */
const DEFAULT_VOICE_LANGUAGE_MODE: VoiceLanguageMode = 'caller';

let warnedUnknownLanguageMode = false;

/**
 * `VOICE_LANGUAGE_MODE` — unset (or `caller`) mirrors the speaker; `english`
 * locks the line to English. Anything else falls back to the default rather
 * than reaching a live call with an unintended persona.
 */
export function resolveVoiceLanguageMode(env: NodeJS.ProcessEnv = process.env): VoiceLanguageMode {
  // `||`, not `??`: env plumbing delivers an unset variable as ''.
  const raw = env['VOICE_LANGUAGE_MODE'] || DEFAULT_VOICE_LANGUAGE_MODE;
  const mode = VOICE_LANGUAGE_MODES.find((candidate) => candidate === raw);
  if (mode) {
    return mode;
  }
  if (!warnedUnknownLanguageMode) {
    // Silence here would leave someone who asked for an English-only line
    // hearing the caller's language back, with nothing in the log to explain it.
    warnedUnknownLanguageMode = true;
    log('warn', {
      event: 'voice.language_mode_ignored',
      value: raw,
      reason: `expected one of ${VOICE_LANGUAGE_MODES.join(', ')}`,
    });
  }
  return DEFAULT_VOICE_LANGUAGE_MODE;
}

/**
 * The one sentence that differs between the language modes. Matched rather
 * than duplicated: the personas stay single-source, and the swap either hits
 * that exact line or leaves the persona untouched.
 */
const ENGLISH_LOCK_LINE =
  /^- Always speak English, regardless of the language the (\w+) speaks\.$/m;

/** Rewrites the English lock into a mirroring rule; `english` returns as-is. */
export function applyLanguageMode(instructions: string, mode: VoiceLanguageMode): string {
  if (mode === 'english') {
    return instructions;
  }
  return instructions.replace(
    ENGLISH_LOCK_LINE,
    (_line, speaker: string) =>
      `- Mirror the ${speaker}: always answer in the language they are speaking, and switch when they switch. If you are unsure of the language, ask in the language of your greeting.`,
  );
}

/**
 * How the channel's input audio should be treated. Values, not wire format:
 * `createPcm24AudioConfig` in the voice core owns the shape these go into, and
 * knows nothing about phones.
 */
export interface CallAudioProfile {
  /** Where the microphone sits: at arm's length, or on the far end of a line. */
  noiseReduction: 'near_field' | 'far_field';
  /** Pin transcription to this language, or `null` to follow the speaker. */
  transcriptionLanguage: string | null;
}

export interface CallProfile {
  /** Tag every forwarded turn carries. On phone this IS the feature: it
   *  selects the spoken turn situation and the reduced tool profile. */
  channel: Extract<TurnChannel, 'voice' | 'phone'>;
  /** Input-audio treatment; the gateway passes it straight to the voice core. */
  audio: CallAudioProfile;
  /** Persona for the realtime model. */
  instructions: string;
  greetingInstructions: (params: { hasHistory: boolean }) => string;
  /** Forced greeting; `null` defers to the attachment's own `hasHistory` rule. */
  speakFirst: boolean | null;
  /** Whether a screen exists to describe. False on phone: the projector is
   *  built without `readScreen` and no screen block rides each response. */
  hasScreen: boolean;
}

/**
 * Who is on the line and how they arrived, decided once from the handshake so
 * nothing downstream re-reads the request to find out.
 *
 * The caller and dialled numbers are optional because they usually are not
 * known: AudioSocket carries a call identifier, audio and DTMF, and nothing
 * else, so a bridge can only report numbers it was told through a side channel.
 * An absent number must stay absent all the way to the persona — a call whose
 * caller is unknown is ordinary, and a call given an invented caller is a
 * confidently wrong fact read back to a real person.
 */
export interface CallContext {
  channel: Extract<TurnChannel, 'voice' | 'phone'>;
  /** E.164, or `null` when withheld, absent, or not in that form. */
  callerNumber: string | null;
  /** The number that was dialled, when the bridge knows it. */
  dialledNumber: string | null;
}

/** E.164: a leading `+`, a non-zero country digit, then up to 14 more. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

function readCallerNumber(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && E164_PATTERN.test(value) ? value : null;
}

/**
 * A real call is announced by the bridge's headers; `?phone_sim=1` is the
 * browser-driven development path into the same arm. Both produce this one
 * shape, so the profile below never learns which of them it came from.
 */
export function resolveCallContext(params: {
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
}): CallContext {
  if (params.headers[CALL_CHANNEL_HEADER] === 'phone') {
    return {
      channel: 'phone',
      callerNumber: readCallerNumber(params.headers, CALL_FROM_HEADER),
      dialledNumber: readCallerNumber(params.headers, CALL_TO_HEADER),
    };
  }
  if (params.query.get(PHONE_SIM_PARAM) === '1') {
    return { channel: 'phone', callerNumber: PHONE_SIM_CALLER, dialledNumber: null };
  }
  return { channel: 'voice', callerNumber: null, dialledNumber: null };
}

export interface VoiceSessionIdentity {
  sessionKey: string;
  userId: string;
}

/**
 * Resolves durable session identity independently from caller presentation.
 * Browser voice may join the browser-selected session. Phone accepts only the
 * trusted request identity, which the real bridge must populate with a
 * platform-created per-call session. Caller ID is deliberately absent.
 */
export function resolveVoiceSessionIdentity(params: {
  channel: CallProfile['channel'];
  requestSessionId: string;
  requestUserId: string;
  requestedBrowserSessionId: string | null;
}): VoiceSessionIdentity {
  const sessionKey =
    params.channel === 'phone'
      ? params.requestSessionId
      : params.requestedBrowserSessionId || params.requestSessionId;
  return { sessionKey, userId: params.requestUserId };
}

/**
 * The browser-voice persona and greeting are passed in rather than imported,
 * because they live next to the gateway that owns them and importing them
 * here would make this module and `voice-gateway.ts` cyclic.
 */
export function resolveCallProfile(params: {
  context: CallContext;
  voice: {
    instructions: string;
    greetingInstructions: (params: { hasHistory: boolean }) => string;
  };
  languageMode?: VoiceLanguageMode;
}): CallProfile {
  const { context, voice } = params;
  const languageMode = params.languageMode ?? resolveVoiceLanguageMode();
  if (context.channel !== 'phone') {
    return {
      channel: 'voice',
      audio: {
        noiseReduction: 'near_field',
        transcriptionLanguage: languageMode === 'english' ? 'en' : null,
      },
      instructions: applyLanguageMode(voice.instructions, languageMode),
      greetingInstructions: voice.greetingInstructions,
      speakFirst: null,
      hasScreen: true,
    };
  }

  return {
    channel: 'phone',
    // A telephone leg is far-field by construction, and anyone can dial the
    // number: the transcriber follows the caller unless the line was explicitly
    // locked to English, which is the same rule the persona already follows.
    audio: {
      noiseReduction: 'far_field',
      transcriptionLanguage: languageMode === 'english' ? 'en' : null,
    },
    instructions: withCallerContext(
      applyLanguageMode(DEPLOYED_PHONE_INSTRUCTIONS, languageMode),
      context.callerNumber,
    ),
    greetingInstructions: ({ hasHistory }) =>
      phoneGreetingInstructions({ hasHistory, languageMode }),
    // The line is open and silent otherwise: a caller who hears nothing after
    // the ring hangs up.
    speakFirst: true,
    hasScreen: false,
  };
}

/**
 * Saying nothing is the correct answer for a caller the network did not
 * identify. The alternative — a persona carrying a caller-ID block for a number
 * nobody supplied — is how a real call once answered with the simulator's
 * fiction-block number and read it back to the caller as fact.
 */
function withCallerContext(instructions: string, callerNumber: string | null): string {
  if (callerNumber === null) {
    return instructions;
  }
  return `${instructions}\n\n${phoneCallerContext(callerNumber)}`;
}

/**
 * The caller-ID block appended to the phone persona per call. Caller ID is
 * network routing data: good enough to personalize with and to answer "what's
 * my number", never good enough to authenticate — numbers are spoofable, and
 * the design (spec §6) forbids treating them as identity.
 */
export function phoneCallerContext(e164: string): string {
  return `CALLER ID: the caller is calling from ${e164}. You may reference their number when asked and use it to personalize the call. It is network caller ID — routing information, NOT proof of identity: never use it to unlock account details or confirm who they are.`;
}

/**
 * The phone persona: `DEPLOYED_VOICE_INSTRUCTIONS` with every screen sentence
 * removed (there is nothing to render, nothing to point at, nothing to answer
 * "what's on my screen" from) and the telephone's own rules added — brevity
 * measured in breaths, and details spelled back rather than sent somewhere.
 *
 * The one deliberate reversal of the browser persona: the greeting discloses
 * that the caller reached an AI assistant. Browser voice hides it; a call must
 * not (EU AI Act Art. 50, in force since 2026-08-02).
 */
export const DEPLOYED_PHONE_INSTRUCTIONS = `You are the realtime spoken interface of the active agent answering this business's phone. The caller is talking to that same agent, not a separate named assistant. Speak in the agent's first-person voice. Warm, brief, natural: this is a telephone call, and the caller hears you and sees nothing. Never invent or state a self-name from platform metadata or technical identifiers.

You may always answer these yourself:
- Greetings, chitchat, and acknowledgments.
- Questions about your voice itself — your accent, how you sound, speaking speed or volume. Answer in one friendly line; these are never about the business.
- Who or what you are — you are this business's AI assistant, which the greeting already said. If asked again, say it plainly in ONE warm line and move on. Never describe models, layers, or how a request travels.
- Collecting details the request needs (service, day, name) BEFORE calling handle_request once.
- When the caller shares something lasting about themselves (a preference, a goal, who they are), call remember_this with one short sentence — then continue naturally, never announce that you saved it.

When the caller merely greets you ("hi", "hello"), do NOT call any tool — reply with one short, natural line and invite the next step. Vary your phrasing every time; never reuse a stock greeting.

Stable phone attachment and interaction affordances are answered locally. Current business or service feasibility, policy, freshness, and actions use handle_request. NEVER say something can't be done: what's possible is the business's fact, not yours — use handle_request and let the reply answer.

Before handle_request returns, a preamble may acknowledge only that you heard the request. Do not claim acceptance, feasibility, refusal, completion, or a particular result. The handle_request result establishes admission; the run result establishes what happened. Stable phone attachment and interaction affordances are answered from this profile. Current business or service feasibility, policy, freshness, and actions use handle_request. A prior capability decision or refusal is a historical fact about that attempt, not current policy. Explain it only in the past tense and attribute it to that attempt; retry present questions and requests.

What you know and may use freely: everything already said in THIS conversation, including the delivered-answer notes in your context. Prior feasibility or policy outcomes are historical facts about their attempts, not present-tense policy. Explain them only in the past tense and attribute them to that attempt. Repeat or rephrase current context naturally.

ALWAYS use handle_request, even if answered before: anything TRANSACTIONAL — availability, prices, bookings, changes, cancellations, anything that acts on the world or could have changed.

Not heard in this conversation: try recall_conversation first for earlier parts of this call; otherwise use handle_request. Never answer business facts from general knowledge.
- "How is it going?" → call get_session_status.
- "Stop" / "cancel" / "wait, no" → call abort_current_run. To change course: abort_current_run, then use handle_request for the new instruction. These NEVER end the call — the caller is still on the line; ask what they'd like instead.
- "Try again" → use handle_request for the previous request again.
- Ending the call is a two-step, like a human receptionist: when the caller sounds finished ("okay", "that's it", "stop", a long pause after an answer), check in ONE natural line — "Anything else I can help you with?" — and keep the line open. Call end_voice_session only after they confirm they're done, or after an unmistakable goodbye ("bye", "that's all, thanks"). Your brief warm farewell comes after it returns.

Speaking on the telephone:
- Keep every answer to a breath or two. One short sentence; two only when truly necessary. A caller cannot skim.
- Spell out critical details slowly — names, dates, times, amounts, confirmation numbers — and read them back so the caller can correct you.
- For anything long, or anything that has to be spelled exactly (an address, an email, a link), spell it out slowly and read it back — do NOT offer to text or email it, those channels do not exist yet.
- Never read out markdown, lists, or URLs.
- While something is in progress, say plainly what is happening in your own words — a short natural line. Never leave the line silent, and never claim to play music or transfer the caller.
- The only things you can do for a caller are answer from this conversation or use handle_request for their request or question. NEVER offer to transfer the call, call them back, have someone contact them, take a message for a person, text them, or email them — none of those channels exist yet. Asked for one, say plainly you cannot do that today, and offer what you can do instead. This bounds YOUR channels, not the business's services: what the business itself can do is still never yours to refuse — use handle_request.

Strict rules:
- When calling handle_request, a preamble is optional. If you use one, acknowledge only that you heard the request in a few casual words; never announce internal work or repeat the request back.
- Never mention tools, internal actors, systems, routing, or any internal mechanics. Never mention screens or anything visual: the caller has none.
- Be honest about COMPLETION. Only the handle_request result establishes whether the request was admitted; only the run result establishes feasibility and completion.
- Always speak English, regardless of the language the caller speaks.
- Speak calmly and unhurried. Prefer fewer words; never pad with pleasantries or filler.`;

/**
 * Greeting for a call. Same shape as the browser greeting (one short opener,
 * varied every time, welcome-back when the caller has history) plus the
 * non-negotiable disclosure — it is the first thing said, on every call.
 *
 * In `caller` language mode the opener still goes out in English (nobody has
 * spoken yet, so there is nothing to mirror), which would leave the disclosure
 * unintelligible to a caller who does not speak it — the law wants it
 * understood, not merely uttered. Hence the repeat once their language is
 * known.
 */
export function phoneGreetingInstructions(params: {
  hasHistory: boolean;
  /** Always supplied by `resolveCallProfile`; omitting it yields the plain
   *  disclosure, which is the English-mode text. */
  languageMode?: VoiceLanguageMode;
}): string {
  const { hasHistory, languageMode = 'english' } = params;
  const invitation = hasHistory
    ? 'then briefly welcome them back and invite them to continue — do not restart or summarize the conversation.'
    : 'then invite their question or request.';
  const mirroring =
    languageMode === 'caller'
      ? ' Open the call in English; if the caller responds in another language, repeat the assistant disclosure once, briefly, in their language, then continue in it.'
      : '';
  return `Answer the call with ONE short spoken line, first person: greet the caller warmly and tell them they have reached this business's AI assistant. That disclosure is required on every call — never drop it, never soften it, never replace it with a joke — ${invitation} Phrase it differently every call; avoid canned lines. Never mention tools, systems, or any caller detail beyond their name unless they bring it up. Calm and unhurried.${mirroring}`;
}
