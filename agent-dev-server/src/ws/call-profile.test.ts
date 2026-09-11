import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyLanguageMode,
  DEPLOYED_PHONE_INSTRUCTIONS,
  phoneGreetingInstructions,
  CALL_CHANNEL_HEADER,
  CALL_FROM_HEADER,
  CALL_TO_HEADER,
  PHONE_SIM_CALLER,
  resolveCallContext,
  resolveCallProfile,
  resolveVoiceSessionIdentity,
  resolveVoiceLanguageMode,
  type VoiceLanguageMode,
} from './call-profile.ts';

/**
 * The English lock exactly as the PHONE persona carries it. The phone arm is
 * where a pinned language earns its keep: a band-limited accented line is what
 * transcription gets wrong.
 */
const PHONE_ENGLISH_LOCK = '- Always speak English, regardless of the language the caller speaks.';

/**
 * The visitor-worded lock. The real browser persona no longer carries it —
 * browser voice mirrors the visitor's language — so this is a FIXTURE: the
 * stubs below plant it to give the swap a target, which is what proves
 * `applyLanguageMode` acts on whatever persona it is handed rather than on the
 * phone wording alone.
 */
const BROWSER_ENGLISH_LOCK =
  '- Always speak English, regardless of the language the visitor speaks.';

const VOICE_STUB = {
  instructions: 'BROWSER VOICE PERSONA',
  greetingInstructions: ({ hasHistory }: { hasHistory: boolean }) =>
    `BROWSER GREETING ${hasHistory ? 'back' : 'fresh'}`,
};

/**
 * The browser persona lives in `voice-gateway.ts`, which cannot be imported
 * here (it opens sockets, and importing it back would make the two modules
 * cyclic). Reading its source keeps the language swap honest about the text it
 * actually runs against — see `zone-boundary.test.ts` for the same approach.
 */
function browserPersona(): string {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'voice-gateway.ts'),
    'utf8',
  );
  const persona = /const DEPLOYED_VOICE_INSTRUCTIONS = `([^`]*)`/.exec(source);
  if (!persona?.[1]) {
    throw new Error('DEPLOYED_VOICE_INSTRUCTIONS not found in voice-gateway.ts');
  }
  return persona[1];
}

function browserAdmissionInstructions(): string {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'voice-gateway.ts'),
    'utf8',
  );
  const instructions = /const DEPLOYED_ADMISSION_INSTRUCTIONS = `([^`]*)`/.exec(source);
  if (!instructions?.[1]) {
    throw new Error('DEPLOYED_ADMISSION_INSTRUCTIONS not found in voice-gateway.ts');
  }
  return instructions[1];
}

function profileFor(query: string, languageMode: VoiceLanguageMode = 'english') {
  return resolveCallProfile({
    context: resolveCallContext({ query: new URLSearchParams(query), headers: {} }),
    voice: VOICE_STUB,
    languageMode,
  });
}

describe('resolveCallContext', () => {
  const query = new URLSearchParams();

  it('takes a real call from the bridge headers, with the caller it carries', () => {
    assert.deepStrictEqual(
      resolveCallContext({
        query,
        headers: {
          [CALL_CHANNEL_HEADER]: 'phone',
          [CALL_FROM_HEADER]: '+447700900123',
          [CALL_TO_HEADER]: '+13473543548',
        },
      }),
      { channel: 'phone', callerNumber: '+447700900123', dialledNumber: '+13473543548' },
    );
  });

  it('is a call with no caller when the network withheld the number', () => {
    const context = resolveCallContext({ query, headers: { [CALL_CHANNEL_HEADER]: 'phone' } });
    assert.strictEqual(context.channel, 'phone');
    assert.strictEqual(context.callerNumber, null);
  });

  it('refuses a caller number that is not E.164 rather than passing it to the persona', () => {
    for (const value of ['unknown', 'anonymous', '', '+', '447700900123', '+44 7700 900123']) {
      const context = resolveCallContext({
        query,
        headers: { [CALL_CHANNEL_HEADER]: 'phone', [CALL_FROM_HEADER]: value },
      });
      assert.strictEqual(context.callerNumber, null, `accepted ${JSON.stringify(value)}`);
    }
  });

  it('keeps the browser simulator on the phone arm, with its fiction-block number', () => {
    const context = resolveCallContext({
      query: new URLSearchParams('phone_sim=1'),
      headers: {},
    });
    assert.deepStrictEqual(context, {
      channel: 'phone',
      callerNumber: PHONE_SIM_CALLER,
      dialledNumber: null,
    });
  });

  it('is browser voice when nothing claims a call', () => {
    assert.deepStrictEqual(resolveCallContext({ query, headers: {} }), {
      channel: 'voice',
      callerNumber: null,
      dialledNumber: null,
    });
  });
});

describe('resolveCallProfile — caller identity', () => {
  function phoneProfileFor(headers: Record<string, string>) {
    return resolveCallProfile({
      context: resolveCallContext({ query: new URLSearchParams(), headers }),
      voice: VOICE_STUB,
      languageMode: 'english',
    });
  }

  it('tells the persona who is calling when the bridge supplied a number', () => {
    const profile = phoneProfileFor({
      [CALL_CHANNEL_HEADER]: 'phone',
      [CALL_FROM_HEADER]: '+447700900123',
    });
    assert.ok(profile.instructions.includes('+447700900123'));
  });

  it('says nothing about a caller it does not know, rather than inventing one', () => {
    // The regression: a real call once answered "+1 555 501 00" — the simulator's
    // fiction-block number — because the persona always carried a caller-ID block.
    const profile = phoneProfileFor({ [CALL_CHANNEL_HEADER]: 'phone' });
    assert.ok(!profile.instructions.includes('CALLER ID'));
    assert.ok(!profile.instructions.includes(PHONE_SIM_CALLER));
  });
});

describe('resolveCallProfile — browser voice', () => {
  it('is untouched without the flag: same persona, greeting, and screen', () => {
    const profile = profileFor('?agent_session_id=browser-session');
    assert.strictEqual(profile.channel, 'voice');
    assert.strictEqual(profile.instructions, VOICE_STUB.instructions);
    assert.strictEqual(profile.greetingInstructions({ hasHistory: true }), 'BROWSER GREETING back');
    assert.strictEqual(profile.hasScreen, true);
  });

  it("leaves the greeting decision to the attachment's hasHistory rule", () => {
    assert.strictEqual(profileFor('').speakFirst, null);
  });

  it('ignores anything but an exact phone_sim=1', () => {
    assert.strictEqual(profileFor('?phone_sim=0').channel, 'voice');
    assert.strictEqual(profileFor('?phone_sim=true').channel, 'voice');
  });
});

describe('resolveCallProfile — phone sim', () => {
  it('tags the phone channel without carrying durable identity', () => {
    const profile = profileFor('?phone_sim=1');
    assert.strictEqual(profile.channel, 'phone');
    assert.strictEqual('sessionKey' in profile, false);
    assert.strictEqual('userId' in profile, false);
  });

  it('always speaks first — a silent line reads as a dropped call', () => {
    assert.strictEqual(profileFor('?phone_sim=1').speakFirst, true);
    assert.strictEqual(profileFor('?phone_sim=1&agent_session_id=call-1').speakFirst, true);
  });

  it('has no screen, so the projector gets no readScreen', () => {
    assert.strictEqual(profileFor('?phone_sim=1').hasScreen, false);
  });

  it('swaps in the phone persona', () => {
    assert.ok(profileFor('?phone_sim=1').instructions.startsWith(DEPLOYED_PHONE_INSTRUCTIONS));
  });

  it('tells the voice model the caller ID — as context, never as identity', () => {
    const instructions = profileFor('?phone_sim=1').instructions;
    assert.match(instructions, /CALLER ID: .*\+15550100/);
    assert.match(instructions, /NOT proof of identity/);
  });
});

describe('resolveVoiceSessionIdentity', () => {
  it('lets browser voice join the selected browser session', () => {
    assert.deepStrictEqual(
      resolveVoiceSessionIdentity({
        channel: 'voice',
        requestSessionId: 'request-session',
        requestUserId: 'visitor-42',
        requestedBrowserSessionId: 'browser-session',
      }),
      { sessionKey: 'browser-session', userId: 'visitor-42' },
    );
  });

  it('uses trusted request identity and ignores browser selection for phone', () => {
    assert.deepStrictEqual(
      resolveVoiceSessionIdentity({
        channel: 'phone',
        requestSessionId: 'platform-call-session',
        requestUserId: 'phone-bridge',
        requestedBrowserSessionId: 'shared-browser-session',
      }),
      { sessionKey: 'platform-call-session', userId: 'phone-bridge' },
    );
  });
});

describe('DEPLOYED_PHONE_INSTRUCTIONS', () => {
  it('keeps delegation speech receipt-only and routes current capability claims', () => {
    for (const instructions of [browserPersona(), DEPLOYED_PHONE_INSTRUCTIONS]) {
      assert.match(instructions, /active agent/);
      assert.match(
        instructions,
        /(?:never as a separate assistant|not a separate named assistant)/,
      );
      assert.match(instructions, /Never invent or state a self-name/);
      assert.match(
        instructions,
        /Before .* returns, a preamble may acknowledge only that you heard the request/,
      );
      assert.match(
        instructions,
        /handle_request result establishes admission; the run result establishes what happened/,
      );
      assert.match(instructions, /historical fact about that attempt, not current policy/);
      assert.match(instructions, /feasibility, policy, freshness, and actions use handle_request/);
      assert.match(
        instructions,
        /Only the handle_request result establishes whether the request was admitted; only the run result establishes feasibility and completion/,
      );
      assert.match(instructions, /farewell comes after it returns/);
      assert.doesNotMatch(instructions, /every question about what can be done.*goes through/);
      assert.doesNotMatch(
        instructions,
        /When forwarding, acknowledge briefly and naturally in the same turn/,
      );
      assert.doesNotMatch(
        instructions,
        /When forwarding, acknowledge in a few casual words in the same turn/,
      );
      assert.doesNotMatch(instructions, /always accept and pass on voice requests/);
      assert.match(instructions, /Prior feasibility or policy\s+outcomes are historical facts/);
    }
    assert.match(browserPersona(), /who the agent is.*use handle_request/);
    assert.doesNotMatch(
      browserPersona(),
      /I can book that for you|I'll bring it up on your screen|I'll do it|I'm on it/,
    );
    assert.doesNotMatch(
      DEPLOYED_PHONE_INSTRUCTIONS,
      /I can book that for you|I'll check that|I'll do it|I'm on it/,
    );
  });

  it('does not prime the old intermediary acknowledgement language', () => {
    for (const instructions of [browserPersona(), DEPLOYED_PHONE_INSTRUCTIONS]) {
      assert.doesNotMatch(instructions, /send_agent_message/);
      assert.doesNotMatch(instructions, /\bforward(?:ed|ing)?\b/i);
    }
    const admission = browserAdmissionInstructions();
    assert.match(admission, /active agent's first-person voice/);
    assert.doesNotMatch(admission, /\b(?:ask|forward|pass)\b/i);
  });

  it('drops every screen rule the browser persona carries', () => {
    for (const removed of [
      /CURRENT SCREEN/,
      /on your screen/i,
      /on their screen/i,
      /render/i,
      /answer_pending_action/,
      /bring it up/i,
      /appear on it/i,
    ]) {
      assert.strictEqual(
        removed.test(DEPLOYED_PHONE_INSTRUCTIONS),
        false,
        `${removed} survived into the phone persona`,
      );
    }
  });

  it('mentions a screen only to say the caller has none', () => {
    const lines = DEPLOYED_PHONE_INSTRUCTIONS.split('\n').filter((line) => /screen/i.test(line));
    for (const line of lines) {
      assert.match(line, /Never mention screens/);
    }
  });

  it('carries the telephone rules the browser persona has no reason to have', () => {
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /breath or two/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /Spell out critical details/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /do NOT offer to text or email it/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /never claim to play music or transfer the caller/);
  });

  it('bounds its own channels, so it cannot promise a transfer, callback, text or email', () => {
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /NEVER offer to transfer the call/);
    for (const absentChannel of [
      /call them back/,
      /have someone contact them/,
      /take a message for a person/,
      /text them/,
      /email them/,
    ]) {
      assert.match(DEPLOYED_PHONE_INSTRUCTIONS, absentChannel);
    }
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /none of those channels exist yet/);
  });

  it('bounds only its own channels while business capability still uses handle_request', () => {
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /never yours to refuse — use handle_request/);
  });

  it('keeps the memory, status, abort and always-handle rules from browser voice', () => {
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /remember_this/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /recall_conversation/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /get_session_status/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /abort_current_run/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /ALWAYS use handle_request/);
  });

  it('never tells the model to hide being an AI — the call must disclose it', () => {
    assert.strictEqual(/NEVER mention being an AI/.test(DEPLOYED_PHONE_INSTRUCTIONS), false);
  });

  it('ends a call in two steps, so nobody is hung up on mid-thought', () => {
    // A caller who says "okay, thanks" is often not finished. The persona has
    // to offer the line back and hear a confirmation before it hangs up, and
    // the goodbye belongs to that same closing turn.
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /Ending the call is a two-step/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /check in ONE natural line/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /Anything else I can help you with\?/);
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /keep the line open/);
    assert.match(
      DEPLOYED_PHONE_INSTRUCTIONS,
      /Call end_voice_session only after they confirm they're done, or after an unmistakable goodbye/,
    );
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /brief warm farewell comes after it returns/);
  });

  it('treats stop and cancel as stopping the work, never as hanging up', () => {
    // On a screen "stop" ends what is on it; on the telephone the caller is
    // still there afterwards, waiting to be asked what they want instead.
    assert.match(
      DEPLOYED_PHONE_INSTRUCTIONS,
      /"Stop" \/ "cancel" \/ "wait, no" → call abort_current_run/,
    );
    assert.match(
      DEPLOYED_PHONE_INSTRUCTIONS,
      /These NEVER end the call — the caller is still on the line/,
    );
    assert.match(DEPLOYED_PHONE_INSTRUCTIONS, /ask what they'd like instead/);
  });
});

describe('resolveVoiceLanguageMode', () => {
  it('defaults to caller — sessions are multilingual unless someone opts out', () => {
    assert.strictEqual(resolveVoiceLanguageMode({}), 'caller');
    // The empty string is what compose passes for an unset var.
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: '' }), 'caller');
  });

  it('reads the two supported modes, english being the explicit opt-out', () => {
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: 'english' }), 'english');
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: 'caller' }), 'caller');
  });

  it('falls back to the default on anything else rather than guessing an opt-out', () => {
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: 'Caller' }), 'caller');
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: 'français' }), 'caller');
    assert.strictEqual(resolveVoiceLanguageMode({ VOICE_LANGUAGE_MODE: 'true' }), 'caller');
  });
});

describe('applyLanguageMode', () => {
  it('leaves both personas byte-identical in explicit english mode', () => {
    assert.strictEqual(
      applyLanguageMode(DEPLOYED_PHONE_INSTRUCTIONS, 'english'),
      DEPLOYED_PHONE_INSTRUCTIONS,
    );
    assert.strictEqual(applyLanguageMode(browserPersona(), 'english'), browserPersona());
    assert.ok(DEPLOYED_PHONE_INSTRUCTIONS.includes(PHONE_ENGLISH_LOCK));
  });

  it('swaps the lock for a mirroring rule in caller mode, and changes nothing else', () => {
    for (const [persona, lock, noun] of [
      [DEPLOYED_PHONE_INSTRUCTIONS, PHONE_ENGLISH_LOCK, 'caller'],
    ] as const) {
      const mirrored = applyLanguageMode(persona, 'caller');
      const mirrorRule = `- Mirror the ${noun}: always answer in the language they are speaking, and switch when they switch. If you are unsure of the language, ask in the language of your greeting.`;
      assert.strictEqual(mirrored.includes(lock), false);
      assert.ok(mirrored.includes(mirrorRule));
      assert.strictEqual(mirrored, persona.replace(lock, mirrorRule));
    }
  });
});

describe('language mode through resolveCallProfile', () => {
  it('mirrors on both arms in caller mode', () => {
    assert.strictEqual(
      profileFor('', 'caller').instructions,
      applyLanguageMode(VOICE_STUB.instructions, 'caller'),
    );
    assert.ok(
      profileFor('?phone_sim=1', 'caller').instructions.startsWith(
        applyLanguageMode(DEPLOYED_PHONE_INSTRUCTIONS, 'caller'),
      ),
    );
  });

  it('keeps the english persona verbatim when english is asked for explicitly', () => {
    assert.ok(profileFor('?phone_sim=1').instructions.includes(PHONE_ENGLISH_LOCK));
    assert.strictEqual(profileFor('').instructions, VOICE_STUB.instructions);
  });

  it('carries the mode into the phone greeting', () => {
    const greeting = profileFor('?phone_sim=1', 'caller').greetingInstructions({
      hasHistory: false,
    });
    assert.match(greeting, /repeat the assistant disclosure once/);
  });
});

/**
 * The env-driven default, exercised through the real resolver rather than the
 * `languageMode` override every other test passes — that override is what makes
 * those tests deterministic, and it would hide a flipped default entirely.
 */
describe('resolveCallProfile — language default from the environment', () => {
  /** Browser stub that actually carries the lock line, so the swap has a
   *  target — `VOICE_STUB` has none and would pass either way. */
  const LOCKED_VOICE_STUB = {
    instructions: `BROWSER VOICE PERSONA\n${BROWSER_ENGLISH_LOCK}`,
    greetingInstructions: VOICE_STUB.greetingInstructions,
  };

  function profileWithEnv(query: string, value: string | undefined) {
    const previous = process.env['VOICE_LANGUAGE_MODE'];
    if (value === undefined) {
      delete process.env['VOICE_LANGUAGE_MODE'];
    } else {
      process.env['VOICE_LANGUAGE_MODE'] = value;
    }
    try {
      return resolveCallProfile({
        context: resolveCallContext({ query: new URLSearchParams(query), headers: {} }),
        voice: LOCKED_VOICE_STUB,
      });
    } finally {
      if (previous === undefined) {
        delete process.env['VOICE_LANGUAGE_MODE'];
      } else {
        process.env['VOICE_LANGUAGE_MODE'] = previous;
      }
    }
  }

  it('mirrors the speaker on an unconfigured runtime — multilingual is the default', () => {
    const phone = profileWithEnv('?phone_sim=1', undefined);
    assert.strictEqual(phone.instructions.includes(PHONE_ENGLISH_LOCK), false);
    assert.match(phone.instructions, /Mirror the caller/);
    assert.match(
      phone.greetingInstructions({ hasHistory: false }),
      /repeat the assistant disclosure once/,
    );

    const browser = profileWithEnv('', undefined);
    assert.strictEqual(browser.instructions.includes(BROWSER_ENGLISH_LOCK), false);
    assert.match(browser.instructions, /Mirror the visitor/);
  });

  it('locks to English only when VOICE_LANGUAGE_MODE=english says so', () => {
    const phone = profileWithEnv('?phone_sim=1', 'english');
    assert.ok(phone.instructions.includes(PHONE_ENGLISH_LOCK));
    assert.strictEqual(/language/i.test(phone.greetingInstructions({ hasHistory: false })), false);
    assert.ok(profileWithEnv('', 'english').instructions.includes(BROWSER_ENGLISH_LOCK));
  });
});

describe('phoneGreetingInstructions', () => {
  it('discloses the AI assistant generically, non-removably', () => {
    const text = phoneGreetingInstructions({ hasHistory: false });
    assert.match(text, /this business's AI assistant/);
    assert.match(text, /required on every call/);
    assert.doesNotMatch(text, /Aurora Spa|cfg-internal-123/);
  });

  it('welcomes a returning caller back instead of opening cold', () => {
    assert.match(phoneGreetingInstructions({ hasHistory: true }), /welcome them back/);
  });

  it('says nothing about language in english mode', () => {
    assert.strictEqual(
      phoneGreetingInstructions({ hasHistory: false }),
      phoneGreetingInstructions({
        hasHistory: false,
        languageMode: 'english',
      }),
    );
    assert.strictEqual(/language/i.test(phoneGreetingInstructions({ hasHistory: false })), false);
  });

  it('repeats the disclosure in the caller language, so it is understood and not just said', () => {
    const english = phoneGreetingInstructions({ hasHistory: false });
    const mirrored = phoneGreetingInstructions({
      hasHistory: false,
      languageMode: 'caller',
    });
    assert.ok(mirrored.startsWith(english));
    assert.match(mirrored, /Open the call in English/);
    assert.match(mirrored, /repeat the assistant disclosure once, briefly, in their language/);
  });
});

describe('resolveCallProfile — input audio', () => {
  it('treats a browser microphone as near-field and follows the speaker', () => {
    assert.deepStrictEqual(profileFor('', 'caller').audio, {
      noiseReduction: 'near_field',
      transcriptionLanguage: null,
    });
  });

  it('does not pin browser transcription to English in caller mode', () => {
    assert.deepStrictEqual(profileFor('', 'caller').audio, {
      noiseReduction: 'near_field',
      transcriptionLanguage: null,
    });
  });

  it('treats a telephone leg as far-field', () => {
    assert.strictEqual(profileFor('?phone_sim=1').audio.noiseReduction, 'far_field');
    assert.strictEqual(profileFor('?phone_sim=1', 'caller').audio.noiseReduction, 'far_field');
  });

  it('lets the phone transcriber follow whoever dialled in', () => {
    // The persona is rewritten to mirror the caller in this mode; pinning the
    // transcriber to English here would transcribe a Polish caller into English
    // while the agent answers them in Polish.
    assert.strictEqual(profileFor('?phone_sim=1', 'caller').audio.transcriptionLanguage, null);
  });

  it('pins the phone transcriber only on a line explicitly locked to English', () => {
    assert.strictEqual(profileFor('?phone_sim=1', 'english').audio.transcriptionLanguage, 'en');
  });

  it('agrees with the persona about language on every arm', () => {
    // The defect this guards: the two were resolved independently, so the
    // instructions could say "mirror the caller" while the audio config said
    // "English only". They now come from one `languageMode` in one function.
    for (const query of ['', '?phone_sim=1']) {
      const english = profileFor(query, 'english');
      assert.strictEqual(
        english.audio.transcriptionLanguage,
        'en',
        `${query || 'browser'} pins English when the persona is locked to it`,
      );
    }
    const mirroringPhone = profileFor('?phone_sim=1', 'caller');
    assert.match(mirroringPhone.instructions, /Mirror the caller/);
    assert.strictEqual(mirroringPhone.audio.transcriptionLanguage, null);
  });
});
