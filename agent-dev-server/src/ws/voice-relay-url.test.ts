import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildRelayUrl } from './voice-relay-url.ts';

describe('buildRelayUrl', () => {
  it('carries the model the agent chose plus the channel it is serving', () => {
    const url = new URL(
      buildRelayUrl({
        baseUrl: 'https://api.agentplace.io',
        accessKey: 'access-key',
        channel: 'phone',
        model: 'gpt-realtime-2.1-mini',
      }),
    );
    assert.strictEqual(url.protocol, 'wss:');
    assert.strictEqual(url.pathname, '/api/gateway/realtime');
    assert.strictEqual(url.searchParams.get('model'), 'gpt-realtime-2.1-mini');
    assert.strictEqual(url.searchParams.get('channel'), 'phone');
    assert.strictEqual(url.searchParams.get('token'), 'access-key');
  });

  it('sends a non-OpenAI id verbatim — routing it is the platform relay job', () => {
    const url = new URL(
      buildRelayUrl({
        baseUrl: 'https://api.agentplace.io',
        accessKey: 'k',
        channel: 'voice',
        model: 'gemini-live-2.5-flash-native-audio',
      }),
    );
    assert.strictEqual(url.searchParams.get('model'), 'gemini-live-2.5-flash-native-audio');
    assert.strictEqual(url.searchParams.get('channel'), 'voice');
  });

  it('maps the http origin onto the ws scheme and drops a trailing slash', () => {
    assert.strictEqual(
      buildRelayUrl({
        baseUrl: 'http://localhost:8080/',
        accessKey: 'k',
        channel: 'voice',
        model: 'gpt-realtime-2.1',
      }),
      'ws://localhost:8080/api/gateway/realtime?model=gpt-realtime-2.1&channel=voice&token=k',
    );
    assert.strictEqual(
      buildRelayUrl({
        baseUrl: 'https://api.agentplace.io',
        accessKey: 'k',
        channel: 'phone',
        model: 'gpt-realtime-2.1-mini',
      }),
      'wss://api.agentplace.io/api/gateway/realtime?model=gpt-realtime-2.1-mini&channel=phone&token=k',
    );
  });

  it('percent-encodes the access key: a JWT-ish token must survive the query string', () => {
    const url = buildRelayUrl({
      baseUrl: 'https://api.agentplace.io',
      accessKey: 'a+b/c=d',
      channel: 'voice',
      model: 'gpt-realtime-2.1',
    });
    assert.ok(url.endsWith('&token=a%2Bb%2Fc%3Dd'));
    assert.strictEqual(new URL(url).searchParams.get('token'), 'a+b/c=d');
  });

  it('percent-encodes the model too, so a stray character cannot forge a parameter', () => {
    const url = buildRelayUrl({
      baseUrl: 'https://api.agentplace.io',
      accessKey: 'k',
      channel: 'voice',
      model: 'gpt-realtime&token=stolen',
    });
    assert.strictEqual(new URL(url).searchParams.get('model'), 'gpt-realtime&token=stolen');
    assert.strictEqual(new URL(url).searchParams.get('token'), 'k');
  });

  it('encodes a Nova id whose colon and slash are query-legal but must round-trip', () => {
    const url = buildRelayUrl({
      baseUrl: 'https://api.agentplace.io',
      accessKey: 'k',
      channel: 'phone',
      model: 'amazon.nova-2-sonic-v1:0',
    });
    assert.strictEqual(new URL(url).searchParams.get('model'), 'amazon.nova-2-sonic-v1:0');
  });
});
