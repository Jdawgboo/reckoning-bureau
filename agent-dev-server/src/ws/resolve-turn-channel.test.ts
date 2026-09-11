import { describe, it } from 'node:test';
import assert from 'node:assert';
import { channelHasLiveScreen, resolveTurnChannel } from './resolve-turn-channel.ts';

describe('resolveTurnChannel', () => {
  it('returns the channel tag the voice gateway sets on startTurn', () => {
    assert.strictEqual(resolveTurnChannel({ channel: 'voice' }), 'voice');
  });

  it('returns undefined when metadata carries no channel (typed omnibox turns)', () => {
    assert.strictEqual(resolveTurnChannel({ voice_active: true }), undefined);
  });

  it('returns undefined when metadata is absent', () => {
    assert.strictEqual(resolveTurnChannel(undefined), undefined);
  });

  it('ignores a non-string channel value', () => {
    assert.strictEqual(resolveTurnChannel({ channel: 42 }), undefined);
  });

  it('rejects an unrecognised channel rather than trusting it', () => {
    assert.strictEqual(resolveTurnChannel({ channel: 'carrier-pigeon' }), undefined);
  });

  it('returns the phone tag a call sets on startTurn', () => {
    assert.strictEqual(resolveTurnChannel({ channel: 'phone' }), 'phone');
  });

  it('does NOT default an untagged send — guessing would label a cron run a visitor', () => {
    assert.strictEqual(resolveTurnChannel({}), undefined);
  });
});

describe('channelHasLiveScreen', () => {
  it('is true only where someone is actually looking at a screen', () => {
    assert.strictEqual(channelHasLiveScreen('omnibox'), true);
    assert.strictEqual(channelHasLiveScreen('chat'), true);
    assert.strictEqual(channelHasLiveScreen('voice'), true);
    assert.strictEqual(channelHasLiveScreen('screen'), true);
  });

  it('is false for programmatic and unattended callers', () => {
    assert.strictEqual(channelHasLiveScreen('http'), false);
    assert.strictEqual(channelHasLiveScreen('mcp'), false);
    assert.strictEqual(channelHasLiveScreen('trigger'), false);
    assert.strictEqual(channelHasLiveScreen('cron'), false);
  });

  it('is false for a phone caller — they hear words and see nothing', () => {
    assert.strictEqual(channelHasLiveScreen('phone'), false);
  });

  it('treats an untagged caller as screenless — the conservative direction', () => {
    assert.strictEqual(channelHasLiveScreen(undefined), false);
  });
});
