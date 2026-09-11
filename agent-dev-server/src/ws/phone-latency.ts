/**
 * `phone.latency` — how long a caller waits, measured per turn.
 *
 * On a call, >3s of silence reads as a dropped line, so the gap between the
 * caller falling silent and the first spoken word is the number worth tuning.
 * One structured line per FORWARDED turn, from the three moments this
 * connection can already observe without adding a single hook to the voice
 * stack:
 *
 *   caller stops speaking → the turn is forwarded to the brain
 *   forwarded            → the brain's first content
 *   forwarded            → the result is handed to the mouth to speak
 *
 * Purely passive: it never gates, delays, or reorders anything, and it holds
 * no state a missed event could corrupt — an unobserved moment is simply an
 * absent field, never a wrong number.
 */
import { log } from '../util/logger.ts';

interface ForwardedTurn {
  forwardedAt: number;
  speechEndToForwardMs: number | null;
  forwardToFirstContentMs: number | null;
  forwardToTurnEndMs: number | null;
}

export interface PhoneLatencyTrackerDeps {
  sessionKey: string;
  /** Clock override for tests. */
  now?: () => number;
  /** Sink override for tests; defaults to one structured log line. */
  emit?: (line: Record<string, unknown>) => void;
}

/** Handle returned by `beginForward`, so the forward's own timestamp is taken
 *  BEFORE the send is awaited — the responseId only exists afterwards, and the
 *  await is part of what we are measuring. */
export interface ForwardHandle {
  attach(responseId: string): void;
}

export class PhoneLatencyTracker {
  readonly #sessionKey: string;
  readonly #now: () => number;
  readonly #emit: (line: Record<string, unknown>) => void;
  readonly #turns = new Map<string, ForwardedTurn>();
  #speechEndedAt: number | null = null;

  constructor(deps: PhoneLatencyTrackerDeps) {
    this.#sessionKey = deps.sessionKey;
    this.#now = deps.now ?? Date.now;
    this.#emit = deps.emit ?? ((line) => log('info', { event: 'phone.latency', ...line }));
  }

  /** The realtime engine reported end-of-speech for the caller's turn. */
  noteSpeechStopped(): void {
    this.#speechEndedAt = this.#now();
  }

  beginForward(): ForwardHandle {
    const forwardedAt = this.#now();
    const speechEndedAt = this.#speechEndedAt;
    // Consumed: the next forward measures from its own speech end, never from
    // a stale one two turns back.
    this.#speechEndedAt = null;
    return {
      attach: (responseId: string) => {
        this.#turns.set(responseId, {
          forwardedAt,
          speechEndToForwardMs: speechEndedAt === null ? null : forwardedAt - speechEndedAt,
          forwardToFirstContentMs: null,
          forwardToTurnEndMs: null,
        });
      },
    };
  }

  /** First content of a forwarded run — the brain has started answering.
   *  Unknown ids are screen-origin runs and are ignored. */
  noteFirstContent(responseId: string): void {
    const turn = this.#turns.get(responseId);
    if (!turn || turn.forwardToFirstContentMs !== null) {
      return;
    }
    turn.forwardToFirstContentMs = this.#now() - turn.forwardedAt;
  }

  noteTurnEnded(responseId: string): void {
    const turn = this.#turns.get(responseId);
    if (!turn || turn.forwardToTurnEndMs !== null) {
      return;
    }
    turn.forwardToTurnEndMs = this.#now() - turn.forwardedAt;
  }

  /**
   * The run's result was handed to the speech scheduler — the last moment
   * this side owns before audio. Flushes the turn: this is the caller-facing
   * number, the one a latency target is set against.
   */
  noteRelayScheduled(responseId: string): void {
    const turn = this.#turns.get(responseId);
    if (!turn) {
      return;
    }
    this.#flush(responseId, turn, this.#now() - turn.forwardedAt);
  }

  /** Connection close: a turn that never produced a relay still reported real
   *  numbers, and a silently dropped line is how latency bugs stay invisible. */
  flushAll(): void {
    for (const [responseId, turn] of this.#turns) {
      this.#flush(responseId, turn, null);
    }
  }

  #flush(responseId: string, turn: ForwardedTurn, forwardToRelayMs: number | null): void {
    this.#turns.delete(responseId);
    this.#emit({
      sessionKey: this.#sessionKey,
      responseId,
      ...(turn.speechEndToForwardMs !== null && {
        speechEndToForwardMs: turn.speechEndToForwardMs,
      }),
      ...(turn.forwardToFirstContentMs !== null && {
        forwardToFirstContentMs: turn.forwardToFirstContentMs,
      }),
      ...(turn.forwardToTurnEndMs !== null && { forwardToTurnEndMs: turn.forwardToTurnEndMs }),
      ...(forwardToRelayMs !== null && { forwardToRelayMs }),
      spoken: forwardToRelayMs !== null,
    });
  }
}
