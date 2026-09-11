/**
 * When to rotate, and what continuity is available when we do — derived from
 * the upstream's own capability declaration, never from its identity.
 *
 * Kept separate from the rotator because these are the only decisions in
 * rotation that are pure: given a `RealtimeCapabilities` and a set of margins,
 * the timing and the continuity strategy follow. Separating them means the
 * capability-driven part is testable without opening a session, and adding a
 * fourth provider is a matter of reading its declaration rather than editing a
 * state machine.
 */

import type { RealtimeCapabilities } from './realtime-upstream.ts';

/**
 * How the replacement session inherits the conversation.
 *
 * `resume` hands the provider its own handle and lets it restore its own state.
 * `replay` seeds a transcript into a fresh session. They are mutually
 * exclusive: doing both duplicates the conversation, which reads to the model as
 * the caller having said everything twice.
 */
export type ContinuityStrategy = 'resume' | 'replay';

/**
 * Continuity follows `sessionResumption` alone.
 *
 * Note this is the *available* strategy, not necessarily the one used: a
 * provider that supports resumption but has not yet issued a handle — Gemini
 * warns with `goAway` from the first minute, and the handle only arrives with
 * the first turn — has to fall back to replay for that rotation.
 */
export function continuityStrategy(capabilities: RealtimeCapabilities): ContinuityStrategy {
  return capabilities.sessionResumption ? 'resume' : 'replay';
}

/** Margins the caller may tune. All default to values derived below. */
export interface RotationTimingOptions {
  /**
   * How far ahead of `maxSessionMs` to start rotating.
   *
   * Flat rather than a fraction of the cap on purpose. What this margin has to
   * cover is one turn boundary plus one session open — both properties of human
   * conversation and network latency, neither of which grows because the
   * provider's cap is longer. LiveKit recycling OpenAI at 20 minutes of 60 is
   * often cited here, but that is a context-size and cost decision, not a cap
   * decision; copying the ratio would rotate an OpenAI call twice for no reason.
   */
  safetyMarginMs?: number;
  /**
   * Time kept in front of a *stated* end so the switch itself can complete.
   * Subtracted from the provider's `session.ending.inMs`, and from the local
   * margin when the provider states nothing.
   */
  hardSwitchReserveMs?: number;
  /**
   * Longest wait for a turn boundary once armed, when nothing states a deadline.
   * Defaults to whatever the safety margin leaves after the switch reserve.
   */
  boundaryWaitMs?: number;
}

export interface RotationTiming {
  /**
   * Delay after a session opens at which to pre-arm, or null when the provider
   * declares no cap and rotation is therefore warning-driven only.
   */
  preArmAfterMs: number | null;
  hardSwitchReserveMs: number;
  boundaryWaitMs: number;
}

/**
 * 90 s: enough for a long answer to finish plus a session open, short enough
 * that a caller mid-sentence at the deadline is rare. Nova's own adapter warns
 * at 60 s and AWS's sample pre-opens with 2 minutes left, so this sits between
 * the two published positions.
 */
const DEFAULT_SAFETY_MARGIN_MS = 90_000;

/** A session open plus the switch. Generous, because overrunning it drops the call. */
const DEFAULT_HARD_SWITCH_RESERVE_MS = 10_000;

export function resolveRotationTiming(
  capabilities: RealtimeCapabilities,
  options: RotationTimingOptions = {},
): RotationTiming {
  const safetyMarginMs = options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  const hardSwitchReserveMs = options.hardSwitchReserveMs ?? DEFAULT_HARD_SWITCH_RESERVE_MS;
  const boundaryWaitMs =
    options.boundaryWaitMs ?? Math.max(0, safetyMarginMs - hardSwitchReserveMs);
  return {
    preArmAfterMs: preArmAfterMs(capabilities.maxSessionMs, safetyMarginMs),
    hardSwitchReserveMs,
    boundaryWaitMs,
  };
}

/**
 * A cap at or below the margin means there is no room to wait at all: arm the
 * moment the session opens rather than scheduling a negative delay, so a
 * provider with a very short cap still rotates instead of silently never
 * arming.
 */
function preArmAfterMs(maxSessionMs: number | null, safetyMarginMs: number): number | null {
  if (maxSessionMs === null) {
    return null;
  }
  return Math.max(0, maxSessionMs - safetyMarginMs);
}

/**
 * How long the rotator may keep waiting for a turn boundary, given what the
 * provider said when it warned.
 *
 * `providerInMs` is `session.ending.inMs` — Gemini's `goAway` states a real
 * number, Nova's adapter states its own estimate, and OpenAI's `session_expired`
 * states 0 because the session is already over. A stated deadline always wins
 * over the local wait, and the reserve comes off it, because the point of the
 * bound is that the switch finishes before the connection dies rather than
 * during.
 */
export function boundaryWaitFor(providerInMs: number | null, timing: RotationTiming): number {
  if (providerInMs === null) {
    return timing.boundaryWaitMs;
  }
  return Math.max(0, Math.min(timing.boundaryWaitMs, providerInMs - timing.hardSwitchReserveMs));
}
