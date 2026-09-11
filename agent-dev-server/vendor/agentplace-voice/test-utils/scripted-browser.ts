/**
 * In-process stand-in for the listener's browser — the other end of the pair
 * `ScriptedUpstream` completes.
 *
 * It exists because "did the listener hear it?" is the one question the
 * provider cannot answer, and a delivery policy that settles instantly in tests
 * proves nothing about the mechanism that decides it. This double owns the same
 * model the real page owns: audio arrives as `response.output_audio.delta`
 * keyed by item, plays on a clock, and reports what actually happened —
 * `voice.playback.completed` when a source ends, `voice.playback.truncate` with
 * the point it stopped when the caller talks over it.
 *
 * What it deliberately does NOT do is decode audio or synthesize speech. A
 * scenario asserts which frames crossed and in what order; whether the words
 * were natural is a live question, not a deterministic one.
 */

import type { VoiceClientLink } from '../realtime-session-manager.ts';

/** Linear PCM16 at 24 kHz mono: two bytes a sample, 24 samples a millisecond. */
const PCM16_24K_BYTES_PER_MS = 48;

export interface ScriptedBrowserOptions {
  bytesPerMillisecond?: number;
  /**
   * Whether playback is reported at all. `false` is the transport that proves
   * nothing — the page that stopped acknowledging, or a tab suspended
   * mid-utterance — and is how the unconfirmed path is exercised.
   */
  acknowledge?: boolean;
}

interface PlaybackItem {
  itemId: string;
  bytes: number;
  playedMs: number;
  inputDone: boolean;
  reported: boolean;
}

export class ScriptedBrowser {
  /** Frames the server sent to this browser, in order. */
  readonly received: Record<string, unknown>[] = [];
  /** Frames this browser sent back to the server, in order. */
  readonly sent: Record<string, unknown>[] = [];

  readonly #bytesPerMs: number;
  readonly #acknowledge: boolean;
  readonly #queue: PlaybackItem[] = [];
  #upstream: ((event: Record<string, unknown>) => void) | null = null;
  #closeHandlers = new Set<() => void>();
  #closed = false;

  constructor(options: ScriptedBrowserOptions = {}) {
    this.#bytesPerMs = options.bytesPerMillisecond ?? PCM16_24K_BYTES_PER_MS;
    this.#acknowledge = options.acknowledge ?? true;
  }

  /** The link handed to `RealtimeSessionManager`. */
  get clientLink(): VoiceClientLink {
    return {
      send: (event) => this.#receive(event),
      onClose: (handler) => {
        if (this.#closed) {
          handler();
          return;
        }
        this.#closeHandlers.add(handler);
      },
      close: () => this.close(),
    };
  }

  /** Where this browser's own frames go — the session that owns the attachment. */
  connectTo(target: { handleClientEvent(event: Record<string, unknown>): void }): void {
    this.#upstream = (event) => target.handleClientEvent(event);
  }

  /** Every frame of a given type this browser received, oldest first. */
  receivedOfType(type: string): Record<string, unknown>[] {
    return this.received.filter((event) => event.type === type);
  }

  /** Every frame of a given type this browser sent, oldest first. */
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((event) => event.type === type);
  }

  /** Audio that has arrived and not yet finished playing, oldest first. */
  pendingItemIds(): string[] {
    return this.#queue.filter((item) => !item.reported).map((item) => item.itemId);
  }

  /** Plays for `ms`, reporting each source that reaches its end. */
  play(ms: number): void {
    let remaining = ms;
    for (const item of this.#queue) {
      if (remaining <= 0) {
        return;
      }
      if (item.reported) {
        continue;
      }
      const durationMs = item.bytes / this.#bytesPerMs;
      const advanced = Math.min(remaining, durationMs - item.playedMs);
      item.playedMs += advanced;
      remaining -= advanced;
      if (item.inputDone && item.playedMs >= durationMs) {
        this.#report(item, { type: 'voice.playback.completed', itemId: item.itemId });
      }
    }
  }

  /** Plays everything currently queued to its end. */
  playAll(): void {
    this.play(this.#totalRemainingMs());
  }

  /**
   * The caller talks over the agent. Every source still playing is cut where it
   * stopped, exactly as the page reports it on `speech_started`.
   */
  bargeIn(): void {
    for (const item of this.#queue) {
      if (item.reported) {
        continue;
      }
      this.#report(item, {
        type: 'voice.playback.truncate',
        itemId: item.itemId,
        contentIndex: 0,
        audioEndMs: Math.round(item.playedMs),
      });
    }
  }

  /** The visitor speaks; the utterance is committed by the provider, not here. */
  speak(audioBase64 = 'AAAA'): void {
    this.#send({ type: 'input_audio_buffer.append', audio: audioBase64 });
  }

  /** Types instead of speaking — the same tool-capable turn, without ASR. */
  type(text: string): void {
    this.#send({ type: 'voice.input', text });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const handler of this.#closeHandlers) {
      handler();
    }
  }

  #receive(event: Record<string, unknown>): void {
    this.received.push(event);
    if (event.type === 'response.output_audio.delta') {
      this.#enqueue(event);
      return;
    }
    if (event.type === 'response.output_audio.done' && typeof event.item_id === 'string') {
      const item = this.#itemFor(event.item_id);
      if (item) {
        item.inputDone = true;
      }
    }
  }

  #enqueue(event: Record<string, unknown>): void {
    if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') {
      return;
    }
    const bytes = Buffer.from(event.delta, 'base64').byteLength;
    const existing = this.#itemFor(event.item_id);
    if (existing) {
      existing.bytes += bytes;
      return;
    }
    this.#queue.push({
      itemId: event.item_id,
      bytes,
      playedMs: 0,
      inputDone: false,
      reported: false,
    });
  }

  /**
   * The live source for an id — the last one, not the first. Provider turn ids
   * restart per connection, so after a rotation the page is handed audio for an
   * id it has already played and must schedule a new source rather than append
   * to a finished one.
   */
  #itemFor(itemId: string): PlaybackItem | undefined {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index];
      if (item.itemId === itemId && !item.reported) {
        return item;
      }
    }
    return undefined;
  }

  #report(item: PlaybackItem, event: Record<string, unknown>): void {
    item.reported = true;
    if (!this.#acknowledge) {
      return;
    }
    this.#send(event);
  }

  #send(event: Record<string, unknown>): void {
    this.sent.push(event);
    this.#upstream?.(event);
  }

  #totalRemainingMs(): number {
    return this.#queue.reduce((total, item) => {
      if (item.reported) {
        return total;
      }
      return total + Math.max(0, item.bytes / this.#bytesPerMs - item.playedMs);
    }, 0);
  }
}
