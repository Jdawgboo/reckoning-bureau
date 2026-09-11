import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldSynthesizeVoiceText } from './voice-reader-policy.ts';

describe('shouldSynthesizeVoiceText', () => {
  it('does not synthesize stored text merely because speech was enabled later', () => {
    assert.equal(
      shouldSynthesizeVoiceText({
        text: 'An answer from before voice was enabled',
        previousText: 'An answer from before voice was enabled',
        speechEnabled: true,
        isRecordingAudio: false,
        voiceEngine: 'legacy',
      }),
      false,
    );
  });

  it('synthesizes only a newly delivered legacy-TTS message', () => {
    assert.equal(
      shouldSynthesizeVoiceText({
        text: 'A new answer',
        previousText: 'The previous answer',
        speechEnabled: true,
        isRecordingAudio: false,
        voiceEngine: 'legacy',
      }),
      true,
    );
  });

  it('leaves realtime speech to the realtime voice connection', () => {
    assert.equal(
      shouldSynthesizeVoiceText({
        text: 'A new answer',
        previousText: 'The previous answer',
        speechEnabled: true,
        isRecordingAudio: false,
        voiceEngine: 'realtime',
      }),
      false,
    );
  });
});
