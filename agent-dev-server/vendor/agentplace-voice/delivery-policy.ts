export interface VoiceDeliverySettlement {
  markPlaybackCompleted(itemId: string): void;
  truncatePlayback(itemId: string, contentIndex: number, audioEndMs: number): void;
  markPlaybackUnconfirmed(itemId: string, message: string): void;
}

export interface VoiceDeliveryOutput {
  itemId: string;
  emittedAudioBytes: number;
}

/**
 * Transport-owned evidence for whether provider audio reached the listener.
 * The realtime manager owns conversation/history settlement; this policy owns
 * only the transport-specific signals and liveness deadline used to prove it.
 */
export interface VoiceDeliveryPolicy {
  start(settlement: VoiceDeliverySettlement): void;
  handleAttachmentEvent(event: Record<string, unknown>): boolean;
  handleProviderEvent(event: Record<string, unknown>): void;
  onOutputTerminal(output: VoiceDeliveryOutput): void;
  onOutputSettled(itemId: string): void;
  dispose(): void;
}

export interface BrowserDeliveryTimeouts {
  minimumPlaybackMs: number;
  playbackGraceMs: number;
  maximumPlaybackMs: number;
}

export interface BrowserDeliveryPolicyOptions {
  bytesPerMillisecond: number;
  timeouts: BrowserDeliveryTimeouts;
}

const PCM24_BYTES_PER_MILLISECOND = 48;
const BROWSER_DELIVERY_TIMEOUTS: BrowserDeliveryTimeouts = {
  minimumPlaybackMs: 2_000,
  playbackGraceMs: 2_000,
  maximumPlaybackMs: 30_000,
};

export function createBrowserPcm24DeliveryPolicy(): BrowserDeliveryPolicy {
  return new BrowserDeliveryPolicy({
    bytesPerMillisecond: PCM24_BYTES_PER_MILLISECOND,
    timeouts: BROWSER_DELIVERY_TIMEOUTS,
  });
}

/**
 * Only OpenAI needs a transcriber named: Gemini Live transcribes natively and
 * this whole block is replaced by `inputAudioTranscription: {}` on that path
 * (`gemini-live-upstream.ts`). Transcription is not optional either way —
 * the session manager's history planes are text, and a user turn stays
 * non-terminal until its transcription settles.
 */
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

/**
 * The hint that made the pinned case worth pinning: telephone-grade audio of a
 * non-native English speaker otherwise gets transcribed into whatever language
 * the accent suggests. It is English-specific, so it rides with the English pin
 * rather than being templated over whatever language is asked for.
 */
const ENGLISH_TRANSCRIPTION_PROMPT =
  'The user always speaks English, possibly with a non-native accent. Transcribe in English only — never switch to another language.';

export interface Pcm24AudioConfigOptions {
  voice: string;
  /**
   * `near_field` is tuned for a laptop microphone at arm's length. `far_field`
   * suits a telephone leg, which arrives band-limited to 3.4 kHz and already
   * carrier-processed.
   */
  noiseReduction: 'near_field' | 'far_field';
  /**
   * Pins transcription to one language, or `null` to let it follow the speaker.
   * `null` is the only setting consistent with a persona that was told to
   * mirror the caller — see `applyLanguageMode` in the runtime's call profile.
   */
  transcriptionLanguage: string | null;
}

/**
 * The realtime input/output audio block. This function owns the wire *shape*
 * only; which values a channel wants is the caller's decision, and lives with
 * the rest of the per-channel differences in `call-profile.ts`.
 *
 * NOTE: `eagerness: 'high'` is the same on every channel. It governs how fast
 * the server VAD calls end-of-turn, and the value that suits a telephone leg
 * has to come from captured call traces rather than a guess — deliberately left
 * alone, and deliberately visible here rather than buried per channel.
 */
export function createPcm24AudioConfig(options: Pcm24AudioConfigOptions): Record<string, unknown> {
  return {
    input: {
      format: { type: 'audio/pcm', rate: 24_000 },
      turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: false },
      transcription: transcriptionConfig(options.transcriptionLanguage),
      noise_reduction: { type: options.noiseReduction },
    },
    output: {
      format: { type: 'audio/pcm', rate: 24_000 },
      voice: options.voice,
    },
  };
}

function transcriptionConfig(language: string | null): Record<string, unknown> {
  if (language === null) {
    return { model: TRANSCRIPTION_MODEL };
  }
  if (language === 'en') {
    return { model: TRANSCRIPTION_MODEL, language, prompt: ENGLISH_TRANSCRIPTION_PROMPT };
  }
  return { model: TRANSCRIPTION_MODEL, language };
}

/** Near-field and English-pinned: a browser session on a laptop microphone. */
export function createBrowserPcm24AudioConfig(voice: string): Record<string, unknown> {
  return createPcm24AudioConfig({
    voice,
    noiseReduction: 'near_field',
    transcriptionLanguage: 'en',
  });
}

/**
 * How many settled item ids are remembered so a late terminal cannot arm a
 * deadline for them. Barge-in settles a turn through its truncate evidence
 * while the cancelled provider is still finishing; that turn's `audio.done`
 * then lands after settlement, and a deadline armed for it can never be
 * answered — the evidence was already consumed — so it would fire as a
 * spurious "reconnect voice" over a conversation that is fine. The skip
 * CONSUMES the id: exactly one late terminal exists per output, and a rotated
 * connection reuses turn ids, so a second terminal under the same id is a new
 * turn that must get a fresh deadline.
 */
const SETTLED_ITEM_MEMORY = 32;

/** Browser playback evidence carried by `voice.playback.*` attachment events. */
export class BrowserDeliveryPolicy implements VoiceDeliveryPolicy {
  readonly #options: BrowserDeliveryPolicyOptions;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #settledItemIds = new Set<string>();
  #settlement: VoiceDeliverySettlement | null = null;

  constructor(options: BrowserDeliveryPolicyOptions) {
    this.#options = options;
  }

  start(settlement: VoiceDeliverySettlement): void {
    if (this.#settlement) {
      throw new Error('browser delivery policy already started');
    }
    this.#settlement = settlement;
  }

  handleAttachmentEvent(event: Record<string, unknown>): boolean {
    if (event.type === 'voice.playback.completed') {
      if (typeof event.itemId === 'string') {
        this.#settlementOrThrow().markPlaybackCompleted(event.itemId);
      }
      return true;
    }
    if (event.type !== 'voice.playback.truncate') {
      return false;
    }
    if (
      typeof event.itemId === 'string' &&
      typeof event.contentIndex === 'number' &&
      typeof event.audioEndMs === 'number'
    ) {
      this.#settlementOrThrow().truncatePlayback(
        event.itemId,
        event.contentIndex,
        event.audioEndMs,
      );
    }
    return true;
  }

  handleProviderEvent(_event: Record<string, unknown>): void {}

  onOutputTerminal(output: VoiceDeliveryOutput): void {
    if (this.#timers.has(output.itemId)) {
      return;
    }
    if (this.#settledItemIds.delete(output.itemId)) {
      return;
    }
    const emittedDurationMs = Math.ceil(
      output.emittedAudioBytes / this.#options.bytesPerMillisecond,
    );
    const expectedMs = emittedDurationMs + this.#options.timeouts.playbackGraceMs;
    const delayMs = Math.min(
      this.#options.timeouts.maximumPlaybackMs,
      Math.max(this.#options.timeouts.minimumPlaybackMs, expectedMs),
    );
    const timer = setTimeout(() => {
      this.#timers.delete(output.itemId);
      this.#settlementOrThrow().markPlaybackUnconfirmed(
        output.itemId,
        'Voice playback was not confirmed; reconnect voice before continuing.',
      );
    }, delayMs);
    timer.unref?.();
    this.#timers.set(output.itemId, timer);
  }

  onOutputSettled(itemId: string): void {
    this.#settledItemIds.add(itemId);
    if (this.#settledItemIds.size > SETTLED_ITEM_MEMORY) {
      const oldest = this.#settledItemIds.values().next().value;
      if (typeof oldest === 'string') {
        this.#settledItemIds.delete(oldest);
      }
    }
    const timer = this.#timers.get(itemId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.#timers.delete(itemId);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }

  #settlementOrThrow(): VoiceDeliverySettlement {
    if (!this.#settlement) {
      throw new Error('browser delivery policy has not started');
    }
    return this.#settlement;
  }
}
