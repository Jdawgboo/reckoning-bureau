import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentModelId,
  DEFAULT_BROWSER_VOICE_MODEL,
  DEFAULT_PHONE_VOICE_MODEL,
  requireModelId,
  resolveVoiceModel,
  voiceRealtimeModel,
} from './config-bridge.ts';

describe('requireModelId', () => {
  it('returns a valid model id unchanged', () => {
    assert.equal(requireModelId('openai.gpt-5.6-terra'), 'openai.gpt-5.6-terra');
  });

  it('trims surrounding whitespace so provider detection sees a clean id', () => {
    assert.equal(requireModelId('  gpt-5.2  '), 'gpt-5.2');
  });

  it('throws a message naming config.ts on missing or blank values', () => {
    for (const value of [undefined, null, '', '   ', 42]) {
      assert.throws(
        () => requireModelId(value),
        /Set modelId in agent-dev-server\/src\/config\.ts/,
        `expected throw for value: ${JSON.stringify(value)}`,
      );
    }
  });
});

describe('agentModelId', () => {
  // Structural only — the builder changes the anchor value, so no literal here.
  it('resolves a non-empty model id from the anchor', () => {
    const modelId = agentModelId();
    assert.equal(typeof modelId, 'string');
    assert.ok(modelId.trim().length > 0);
  });
});

describe('resolveVoiceModel', () => {
  it("uses the agent's own choice for every channel — one id covers both surfaces", () => {
    const chosen = 'gemini-live-2.5-flash-native-audio';
    assert.equal(resolveVoiceModel(chosen, 'phone'), chosen);
    assert.equal(resolveVoiceModel(chosen, 'voice'), chosen);
  });

  it('trims the configured id so the relay never receives padding', () => {
    assert.equal(resolveVoiceModel('  gpt-realtime-2.1  ', 'phone'), 'gpt-realtime-2.1');
  });

  it('falls back per channel when the agent names none: mini for calls, flagship for browser', () => {
    assert.equal(resolveVoiceModel(undefined, 'phone'), 'gpt-realtime-2.1-mini');
    assert.equal(resolveVoiceModel(undefined, 'voice'), 'gpt-realtime-2.1');
    assert.equal(DEFAULT_PHONE_VOICE_MODEL, 'gpt-realtime-2.1-mini');
    assert.equal(DEFAULT_BROWSER_VOICE_MODEL, 'gpt-realtime-2.1');
  });

  it('treats blank and non-string config as unset rather than dialling it', () => {
    for (const value of [undefined, null, '', '   ', 42, { id: 'gpt-realtime' }]) {
      assert.equal(
        resolveVoiceModel(value, 'phone'),
        DEFAULT_PHONE_VOICE_MODEL,
        `expected the default for value: ${JSON.stringify(value)}`,
      );
    }
  });
});

describe('voiceRealtimeModel', () => {
  // Structural only — the builder owns the anchor value.
  it('resolves a non-empty id from the anchor for both voice channels', () => {
    for (const channel of ['phone', 'voice'] as const) {
      const model = voiceRealtimeModel(channel);
      assert.equal(typeof model, 'string');
      assert.ok(model.trim().length > 0);
    }
  });
});
