/**
 * Wire-format negotiation shared by every realtime upstream adapter.
 *
 * Extracted rather than duplicated because the rule is identical for all
 * providers and is a *refusal*, not a conversion: a format the provider cannot
 * serve is a configuration error surfaced at `open`, so it fails at startup
 * instead of becoming audio nobody can explain three layers down.
 */
import type { AudioFormat } from '../realtime-upstream.ts';
import { sameAudioFormat } from '../realtime-upstream.ts';

/** Human-readable format name, used in negotiation errors. */
export function describeAudioFormat(format: AudioFormat): string {
  return `${format.encoding}@${format.sampleRateHz}Hz`;
}

/**
 * Resolves the format a session will actually use, or throws naming both what
 * was asked for and what the provider serves. An omitted request takes the
 * adapter's most-preferred format, which is why `supported` is ordered.
 */
export function negotiateAudioFormat(params: {
  /** Provider name as it should read in the error, e.g. `OpenAI Realtime`. */
  provider: string;
  direction: 'input' | 'output';
  requested: AudioFormat | undefined;
  supported: readonly AudioFormat[];
}): AudioFormat {
  const { provider, direction, requested, supported } = params;
  if (!requested) {
    return supported[0];
  }
  const match = supported.find((candidate) => sameAudioFormat(candidate, requested));
  if (!match) {
    throw new Error(
      `${provider} does not support ${direction} audio as ${describeAudioFormat(requested)} (supported: ${supported.map(describeAudioFormat).join(', ')})`,
    );
  }
  return match;
}
