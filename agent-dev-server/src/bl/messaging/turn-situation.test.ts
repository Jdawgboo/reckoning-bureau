import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  formatSessionLocaleSituation,
  formatTurnSituation,
  formatVoiceLocaleSituation,
} from './turn-situation.ts';

describe('formatTurnSituation — a listener who is waiting', () => {
  it('tells a spoken turn that someone is waiting in silence', () => {
    const situation = formatTurnSituation('voice');

    assert.match(situation, /waiting in silence/);
    assert.match(situation, /report_progress/);
  });

  it('tells a call the same, whatever its own sentence says', () => {
    // A telephone channel states its own situation first; the note must survive
    // that, because a caller has nothing at all to look at while work runs.
    const situation = formatTurnSituation('phone');

    assert.match(situation, /waiting in silence/);
  });

  it('says nothing of the sort to someone reading a screen', () => {
    for (const channel of ['omnibox', 'screen', 'http', 'mcp'] as const) {
      assert.doesNotMatch(
        formatTurnSituation(channel),
        /report_progress/,
        `${channel} shows its work as it happens`,
      );
    }
  });
});

describe('formatTurnSituation', () => {
  it('tells a screenless caller that a render only reaches them as markdown', () => {
    const text = formatTurnSituation('mcp');
    assert.match(text, /NO live screen/);
    assert.match(text, /markdown fallback/);
  });

  it('tells a spoken turn that its reply text is already a delivery', () => {
    const text = formatTurnSituation('voice');
    assert.match(text, /spoken aloud/);
    assert.match(text, /asked to see something new or changed/);
  });

  it('uses trusted presentation authority for screenless voice', () => {
    const text = formatTurnSituation('voice', {
      screenContext: 'absent',
      uiEffects: 'forbidden',
    });
    assert.match(text, /NO live screen/);
    assert.match(text, /do not render or change any UI/);
    assert.doesNotMatch(text, /looking at a screen/);
  });

  it('distinguishes a screen action from a typed question', () => {
    assert.match(formatTurnSituation('screen'), /acted on the screen itself/);
    assert.match(formatTurnSituation('omnibox'), /typed this/);
  });

  it('gives a phone caller a spoken contract, not the written-answer one', () => {
    const text = formatTurnSituation('phone', {
      screenContext: 'absent',
      uiEffects: 'forbidden',
    });
    assert.match(text, /telephone call/);
    assert.match(text, /short spoken sentences/);
    // The two prompts in the phone path must not disagree about what the line
    // can do. The spoken persona says texting is not a channel; this one told
    // the agent to offer it, so a caller could be promised a message that no
    // part of the system can send.
    assert.match(text, /never offer one/);
    assert.strictEqual(/offer to text/.test(text), false);
    assert.strictEqual(
      /well-formatted written answer/.test(text),
      false,
      'the generic screenless branch would tell a caller to write markdown at them',
    );
  });

  it('says nothing at all when the channel is unknown', () => {
    assert.strictEqual(formatTurnSituation(undefined), '');
  });

  it('never contradicts the presentation contract by forbidding a render outright', () => {
    for (const channel of ['voice', 'omnibox', 'screen', 'http', 'mcp'] as const) {
      assert.strictEqual(
        /never render|do not render/i.test(formatTurnSituation(channel)),
        false,
        `${channel} states a fact; the decision stays with the agent`,
      );
    }
  });
});

describe('turn situation delivery', () => {
  it('rides a model middleware, never the persisted user text', async () => {
    // A turn's query text becomes the canonical user message in conversation
    // history, so a situation block folded into it is persisted as the
    // visitor's own words — and shows up wherever those are displayed, such as
    // the turn rail's title. `<ui_state>` uses `transformParams` for exactly
    // this reason; the situation block must too.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const messagingSource = readFileSync(
      fileURLToPath(new URL('./messaging.service.ts', import.meta.url)),
      'utf8',
    );
    const presentationSource = readFileSync(
      fileURLToPath(new URL('./agent-run-presentation.ts', import.meta.url)),
      'utf8',
    );

    assert.match(
      messagingSource,
      /createAgentRunPresentationMiddlewares/,
      'run construction must install the presentation middleware set',
    );
    assert.match(
      presentationSource,
      /createUiStateMiddleware\(async \(\) => formatTurnSituation/,
      'the situation block must be delivered as a model middleware',
    );
    assert.strictEqual(
      /parts\.push\(situation\)/.test(messagingSource),
      false,
      "appending it to the query text persists it as the visitor's own words",
    );
  });
});

describe('session locale situation', () => {
  it('separates dynamic language, stable bundle state, and protected facts', () => {
    const text = formatSessionLocaleSituation(
      { messageLocale: 'fr', formatLocale: 'fr-CA', source: 'conversation', revision: 2 },
      { status: 'pending', attachmentCount: 1 },
    );
    assert.match(text, /new response prose/);
    assert.match(text, /Render component props/);
    assert.match(text, /browser locale is only an initial hint/i);
    assert.match(text, /complete utterance is clearly in another language/);
    assert.match(text, /even if they did not ask to switch/);
    assert.match(text, /unambiguous one-word greeting counts/);
    assert.match(text, /length alone is not a reason to keep the current locale/);
    assert.match(text, /bundle-owned/);
    assert.match(text, /Preserve brands/);
    assert.match(text, /pending/);
    assert.match(text, /do not claim/);
  });

  it('keeps an explicit visitor choice locked until another direct request', () => {
    const text = formatSessionLocaleSituation(
      { messageLocale: 'en', formatLocale: 'en', source: 'explicit', revision: 4 },
      { status: 'active', attachmentCount: 1 },
    );

    assert.match(text, /Authority: explicit/);
    assert.match(text, /conversational evidence cannot override it/);
    assert.match(text, /Only a direct request/);
    assert.doesNotMatch(text, /complete utterance is clearly in another language/);
  });

  it('states acknowledged and fallback stable UI without changing locale authority', () => {
    const locale = {
      messageLocale: 'de',
      formatLocale: 'de-DE',
      source: 'conversation' as const,
      revision: 3,
    };
    assert.match(
      formatSessionLocaleSituation(locale, { status: 'active', attachmentCount: 1 }),
      /acknowledges.*active/,
    );
    assert.match(
      formatSessionLocaleSituation(locale, {
        status: 'source-fallback',
        attachmentCount: 1,
        reason: 'generation-failed',
      }),
      /prior complete language/,
    );
  });

  it('gives voice one committed language and preserves factual values', () => {
    const text = formatVoiceLocaleSituation({
      messageLocale: 'ru',
      formatLocale: 'ru-RU',
      source: 'conversation',
      revision: 4,
    });
    assert.match(text, /committed conversation language is ru/);
    assert.match(text, /set_session_locale/);
    assert.match(text, /complete utterance is clearly in another language/);
    assert.match(text, /even if they did not ask to switch/);
    assert.match(text, /unambiguous one-word greeting counts/);
    assert.match(text, /Preserve brands/);
  });

  it('keeps voice in an explicitly selected language across conversational evidence', () => {
    const text = formatVoiceLocaleSituation({
      messageLocale: 'en',
      formatLocale: 'en',
      source: 'explicit',
      revision: 5,
    });

    assert.match(text, /Authority: explicit/);
    assert.match(text, /conversational evidence cannot override it/);
    assert.doesNotMatch(text, /even if they did not ask to switch/);
  });
});
