/**
 * Which adapter a configured voice model selects — asserted on the FRAME each one
 * puts on the wire, not on the object that was constructed.
 *
 * That is the whole failure this file exists to prevent. The relay passes frames
 * through untouched, so an OpenAI configuration frame sent to Gemini (which
 * demands `setup` first) is accepted by nobody and reported by no one: the socket
 * opens, the session dies, and the visitor hears silence. A test that only checked
 * `instanceof` would have passed throughout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  VOICE_MODEL_UNSERVABLE_CLOSE_CODE,
  VoiceModelUnservableError,
  createRelayVoiceUpstream,
  voiceLocaleProjection,
} from './voice-upstream.ts';
import type { RealtimeSocket } from '../../vendor/agentplace-voice/openai-realtime-socket.ts';
import { ScriptedRealtimePeer } from '../../vendor/agentplace-voice/test-utils/scripted-realtime-peer.ts';
import type { UpstreamSessionConfig } from '../../vendor/agentplace-voice/realtime-upstream.ts';

const GEMINI_MODEL = 'gemini-live-2.5-flash-native-audio';
const NOVA_MODEL = 'amazon.nova-2-sonic-v1:0';
const CONFIG: UpstreamSessionConfig = { instructions: 'Be brief.', tools: [] };

/** Records every socket the adapter dialled, so a per-session dial is assertable. */
function dialer(): { connect: () => Promise<RealtimeSocket>; peers: ScriptedRealtimePeer[] } {
  const peers: ScriptedRealtimePeer[] = [];
  return {
    connect: async () => {
      const peer = new ScriptedRealtimePeer();
      peers.push(peer);
      return peer;
    },
    peers,
  };
}

/** The first frame the adapter sent, which is its session configuration. */
async function firstFrame(model: string): Promise<Record<string, unknown>> {
  const { connect, peers } = dialer();
  const { upstream } = createRelayVoiceUpstream({ model, connect });
  await upstream.open(CONFIG, () => {});
  const first = peers[0]?.sent[0];
  assert.ok(first, `the adapter for ${model} sent nothing`);
  return first;
}

describe('createRelayVoiceUpstream', () => {
  it('states locale projection truth separately for every adapter', () => {
    const strategyFor = (model: string) => {
      const { upstream } = createRelayVoiceUpstream({ model, connect: dialer().connect });
      return voiceLocaleProjection(upstream.capabilities);
    };

    assert.strictEqual(strategyFor('gpt-realtime-2.1-mini'), 'per-response');
    assert.strictEqual(strategyFor(GEMINI_MODEL), 'live-context');
    assert.strictEqual(strategyFor(NOVA_MODEL), 'next-connection');
  });

  it('opens an OpenAI session with an OpenAI configuration frame', async () => {
    const { kind } = createRelayVoiceUpstream({
      model: 'gpt-realtime-2.1-mini',
      connect: dialer().connect,
    });

    assert.strictEqual(kind, 'openai');
    assert.strictEqual((await firstFrame('gpt-realtime-2.1-mini'))['type'], 'session.update');
  });

  it('opens a Gemini session with `setup`, not `session.update`', async () => {
    const { upstream, kind } = createRelayVoiceUpstream({
      model: GEMINI_MODEL,
      connect: dialer().connect,
    });

    assert.strictEqual(kind, 'gemini');
    assert.strictEqual(upstream.id, 'gemini-live');
    const frame = await firstFrame(GEMINI_MODEL);
    assert.ok('setup' in frame, `Gemini's first frame must be setup, got ${JSON.stringify(frame)}`);
  });

  it('names the bare model id in `setup.model`, for the relay to retarget', async () => {
    const setup = (await firstFrame(GEMINI_MODEL))['setup'];

    // The full Vertex resource path embeds a Google project this runtime does not
    // hold; the relay puts it in place of this value on the one frame it appears on.
    assert.ok(setup && typeof setup === 'object');
    assert.strictEqual(Reflect.get(setup, 'model'), GEMINI_MODEL);
  });

  it('opens a Nova session with `sessionStart` over the socket', async () => {
    const { upstream, kind } = createRelayVoiceUpstream({
      model: NOVA_MODEL,
      connect: dialer().connect,
    });

    assert.strictEqual(kind, 'nova');
    assert.strictEqual(upstream.id, 'nova-sonic');
    const frame = await firstFrame(NOVA_MODEL);
    const event = frame['event'];
    assert.ok(event && typeof event === 'object', `Nova frames are { event: … }, got ${frame}`);
    assert.ok(
      'sessionStart' in event,
      `Nova's first frame must be sessionStart, got ${JSON.stringify(event)}`,
    );
  });

  it('dials a fresh socket for every session, so a rotation is a new connection', async () => {
    for (const model of ['gpt-realtime-2.1', GEMINI_MODEL, NOVA_MODEL]) {
      const { connect, peers } = dialer();
      const { upstream } = createRelayVoiceUpstream({ model, connect });

      await upstream.open(CONFIG, () => {});
      await upstream.open(CONFIG, () => {});

      assert.strictEqual(peers.length, 2, `${model} reused one connection for two sessions`);
    }
  });
});

describe('an unservable voice model', () => {
  it('refuses by name rather than choosing a provider on the agent’s behalf', () => {
    for (const model of [
      '',
      'gpt-4o',
      'gemini-2.5-flash',
      'amazon.nova-sonic-v1:0',
      'amazon.nova-2-lite-v1:0',
    ]) {
      assert.throws(
        () => createRelayVoiceUpstream({ model, connect: dialer().connect }),
        (error: unknown) => {
          assert.ok(error instanceof VoiceModelUnservableError);
          assert.strictEqual(error.model, model);
          assert.ok(
            error.message.includes(`'${model}'`),
            `the refusal must name the id it rejected, got: ${error.message}`,
          );
          return true;
        },
      );
    }
  });

  it('refuses with the close code the platform uses for the same condition', () => {
    assert.strictEqual(VOICE_MODEL_UNSERVABLE_CLOSE_CODE, 4004);
  });
});
