/**
 * The browser wire: neutral facts rendered back into the six OpenAI Realtime
 * event names three shipped clients already decode.
 *
 * Before the provider seam existed, the session manager held the provider
 * socket and forwarded these six event types through verbatim — an allowlist
 * over raw frames. It no longer sees a provider frame, so the forwarding has to
 * be re-stated as a projection: one `UpstreamFact` in, at most one client event
 * out, with the names and payloads unchanged.
 *
 * Rendering rather than forwarding is what makes the client wire independent of
 * the provider underneath. The names stay OpenAI's because every shipped client
 * already decodes them — this agent's own browser client in
 * `agent-dev-client/.../voice-realtime.service.ts`, and the other surfaces that
 * speak the same event names — so renaming them is a client migration, not a
 * refactor, and is deliberately not part of moving the orchestrator onto the
 * seam.
 *
 * Only *interim* transcript facts cross: the clients render captions
 * incrementally from the deltas, and the provider's own final transcript
 * restates the whole utterance, which would double every caption line.
 */
import type { UpstreamFact } from './realtime-upstream.ts';

/**
 * Exactly the event types {@link toVoiceClientEvent} can produce. Exported so a
 * test can assert the projection never widens the client wire by accident —
 * every name here is decoded by a shipped client, and a seventh would be
 * dropped silently at the far end.
 */
export const DOWNSTREAM_EVENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'response.output_audio.delta',
  'response.output_audio.done',
  'response.output_audio_transcript.delta',
  'conversation.item.input_audio_transcription.delta',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
]);

/**
 * One client event for this fact, or null when the fact is orchestration-only.
 *
 * Model audio is re-encoded to base64 because that is what the client wire has
 * always carried and what the browser playback path decodes. The adapter
 * decoded it out of the same encoding a moment earlier; carrying bytes across
 * the seam is what lets a telephony transport take the same fact without ever
 * paying for base64 at all.
 */
export function toVoiceClientEvent(fact: UpstreamFact): Record<string, unknown> | null {
  switch (fact.type) {
    case 'model.audio':
      return {
        type: 'response.output_audio.delta',
        item_id: fact.turnId,
        content_index: 0,
        delta: Buffer.from(fact.audio).toString('base64'),
      };
    case 'model.audio.done':
      return { type: 'response.output_audio.done', item_id: fact.turnId };
    case 'model.text':
      if (fact.final) {
        return null;
      }
      return { type: 'response.output_audio_transcript.delta', delta: fact.text };
    case 'caller.transcript':
      if (fact.final) {
        return null;
      }
      return { type: 'conversation.item.input_audio_transcription.delta', delta: fact.text };
    case 'caller.speech.started':
      return { type: 'input_audio_buffer.speech_started' };
    case 'caller.speech.stopped':
      return { type: 'input_audio_buffer.speech_stopped' };
    default:
      return null;
  }
}
