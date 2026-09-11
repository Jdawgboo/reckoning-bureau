/**
 * Realtime voice engine for the deployed client — connects the mic and
 * speakers to the agent's `/voice` WebSocket. Ported from the builder's
 * voice-audio.service: AudioWorklet PCM16 @ 24kHz capture, gapless playback
 * via scheduled buffer times, barge-in clears the playback queue on
 * `speech_started`. No MobX (services layer).
 */
import { getWsBaseUrl } from './api-url';
import { claimFirstVoiceOpen } from './voice-greeting-ledger';
import { AgentAuth } from '../agent-auth';
import type { BrowserVoiceScreenSelection, MemoryEntry } from '../../../../../shared';
import { isRecord } from '../util/type-guards';
import { VoiceRealtimePlaybackQueue } from './voice-realtime-playback-queue';
import { VoiceScreenSelectionTracker } from './voice-screen-selection';

const INPUT_SAMPLE_RATE = 24_000;

const CAPTURE_WORKLET = `
class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
`;

function floatTo16BitBase64(samples: Float32Array): string {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** The client's one PCM decode: 24 kHz PCM16 base64 into playback samples.
 *  Exported so wire-contract tests can drive the real conversion the playback
 *  clock (and therefore every truncation millisecond) is derived from. */
export function base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

// Noise gate: chunks quieter than this RMS are sent as silence so background
// noise (typing, breathing) never reads as speech onset to the server VAD.
const NOISE_GATE_RMS = 0.025;
// Keep the gate open this long after the last loud chunk so word tails and
// short intra-word pauses are not clipped.
const NOISE_GATE_HANGOVER_MS = 400;

function chunkRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/** Live levels (0..1) for the waveform, written by the session's meter loop.
 *  A plain mutable bus read inside the canvas RAF — never React state. */
export const realtimeVoiceLevels = { input: 0, output: 0 };

function analyserRms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) {
    const centered = (v - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / data.length);
}

/** Mic capture (PCM16/24kHz chunks) + gapless playback queue with barge-in clear. */
export class VoiceRealtimeAudio {
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #playbackTime = 0;
  readonly #playback: VoiceRealtimePlaybackQueue;
  #analyser: AnalyserNode | null = null;
  #playbackAnalyser: AnalyserNode | null = null;
  #playbackSink: MediaStreamAudioDestinationNode | null = null;
  #playbackElement: HTMLAudioElement | null = null;
  #muted = false;
  #gateOpenUntil = 0;

  constructor(options?: { onPlaybackComplete?: (itemId: string) => void }) {
    this.#playback = new VoiceRealtimePlaybackQueue(options?.onPlaybackComplete ?? (() => {}));
  }

  /**
   * Opens the mic and streams 24kHz PCM chunks. Browser `noiseSuppression` is
   * deliberately OFF: the realtime session runs OpenAI's `near_field` noise
   * reduction server-side before VAD, and double noise-processing muffles
   * input. `echoCancellation` stays on — it stops the model hearing itself
   * through the speakers.
   */
  async start(onChunk: (base64Pcm: string) => void): Promise<void> {
    this.#context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const workletUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }),
    );
    await this.#context.audioWorklet.addModule(workletUrl);
    const source = this.#context.createMediaStreamSource(this.#stream);
    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = 256;
    source.connect(this.#analyser);
    this.#playbackAnalyser = this.#context.createAnalyser();
    this.#playbackAnalyser.fftSize = 256;
    this.#wirePlayout(this.#context, this.#playbackAnalyser);
    const capture = new AudioWorkletNode(this.#context, 'voice-capture');
    source.connect(capture);
    capture.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (this.#muted) {
        return;
      }
      onChunk(floatTo16BitBase64(this.#applyNoiseGate(ev.data)));
    };
  }

  /** Replace sub-threshold chunks with silence (hangover keeps word tails intact). */
  #applyNoiseGate(samples: Float32Array): Float32Array {
    const now = performance.now();
    if (chunkRms(samples) >= NOISE_GATE_RMS) {
      this.#gateOpenUntil = now + NOISE_GATE_HANGOVER_MS;
      return samples;
    }
    if (now < this.#gateOpenUntil) {
      return samples;
    }
    return new Float32Array(samples.length);
  }

  /** RMS level 0..1 for the waveform accent; 0 while muted so the UI never suggests the mic is heard. */
  level(): number {
    if (!this.#analyser || this.#muted) {
      return 0;
    }
    return analyserRms(this.#analyser);
  }

  playbackLevel(): number {
    return this.#playbackAnalyser ? analyserRms(this.#playbackAnalyser) : 0;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  enqueuePlayback(itemId: string, contentIndex: number, base64Pcm: string): void {
    if (!this.#context) {
      return;
    }
    const samples = base64ToFloat32(base64Pcm);
    const buffer = this.#context.createBuffer(1, samples.length, INPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#playbackAnalyser ?? this.#context.destination);
    const startAt = Math.max(this.#context.currentTime, this.#playbackTime);
    source.start(startAt);
    this.#playbackTime = startAt + buffer.duration;
    this.#playback.enqueue(itemId, contentIndex, startAt, this.#playbackTime, source);
    source.onended = () => {
      this.#playback.sourceEnded(itemId, source);
    };
  }

  markPlaybackInputDone(itemId: string): void {
    this.#playback.markInputDone(itemId);
  }

  hasPlayback(): boolean {
    return this.#playback.hasPlayback();
  }

  /** Barge-in: stop everything queued and classify every affected conversation item. */
  clearPlayback(): {
    completedItemIds: string[];
    truncations: Array<{ itemId: string; contentIndex: number; audioEndMs: number }>;
  } {
    const now = this.#context?.currentTime ?? 0;
    const interruption = this.#playback.clear(now);
    this.#playbackTime = now;
    return interruption;
  }

  async stop(): Promise<void> {
    this.clearPlayback();
    for (const track of this.#stream?.getTracks() ?? []) {
      track.stop();
    }
    this.#playbackElement?.pause();
    if (this.#playbackElement) {
      this.#playbackElement.srcObject = null;
    }
    this.#playbackElement = null;
    this.#playbackSink = null;
    await this.#context?.close();
    this.#context = null;
    this.#stream = null;
    this.#analyser = null;
    this.#playbackAnalyser = null;
  }

  /**
   * The model's voice must play through a media element, not
   * `AudioContext.destination`: Chrome's echo canceller subtracts only
   * element/WebRTC playout from the mic signal, so WebAudio-rendered speech
   * comes back in as caller audio — the model barges in on its own echo and
   * answers a mis-transcription of itself. If the element refuses to play
   * (autoplay policy — no user gesture in the call chain), fall back to the
   * direct output: audible without echo cancellation beats silent.
   */
  #wirePlayout(context: AudioContext, analyser: AnalyserNode): void {
    const sink = context.createMediaStreamDestination();
    analyser.connect(sink);
    const element = new Audio();
    element.srcObject = sink.stream;
    this.#playbackSink = sink;
    this.#playbackElement = element;
    void element.play().catch(() => {
      analyser.disconnect();
      analyser.connect(context.destination);
      element.srcObject = null;
      this.#playbackElement = null;
      this.#playbackSink = null;
    });
  }
}

export type VoiceRealtimeState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'building';

export interface VoiceRealtimeSessionOptions {
  getAgentSessionId: () => string | null;
  screenSelection: BrowserVoiceScreenSelection;
  /** Visitor's saved memory-bank notes (own words, from `persistToMemoryBank`),
   *  sent once on connect so the voice model can use them naturally — full
   *  entries (not just the summary text) so the server can render each
   *  note's freshness. This side only reads them in; new memories the voice
   *  model captures arrive separately via `onMemory`. */
  memories?: MemoryEntry[];
  onState?: (state: VoiceRealtimeState) => void;
  onAssistantCaption?: (delta: string) => void;
  onUserCaption?: (delta: string) => void;
  /** The `remember_this` tool wrote a lasting fact — add it to the same
   *  browser memory bank `persistToMemoryBank` writes to. */
  onMemory?: (summary: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  /** Server's run-truth edge: delegated work started (true) / all of it done (false). */
  onRunBusy?: (busy: boolean) => void;
}

/**
 * `?phone_sim=1` on the PAGE turns this browser into a faked telephone caller:
 * the flag rides to `/voice`, where the gateway swaps in the phone persona,
 * a fresh request-scoped session and the screenless run presentation. Deliberately
 * not a UI control — it is a team-testing lever for the phone fast path, not a
 * visitor-facing mode.
 */
function phoneSimRequested(): boolean {
  return new URLSearchParams(window.location.search).get('phone_sim') === '1';
}

function buildVoiceWsUrl(agentSessionId: string | null): string {
  const url = new URL('/voice', getWsBaseUrl());
  if (phoneSimRequested()) {
    // No `agent_session_id`: every simulated call gets the request's fresh
    // session identity rather than attaching to the browser conversation.
    url.searchParams.set('phone_sim', '1');
    return url.toString();
  }
  if (agentSessionId) {
    url.searchParams.set('agent_session_id', agentSessionId);
  }
  return url.toString();
}

/**
 * One live voice session: `/voice` WS + audio wiring. Mic chunks go up as
 * `input_audio_buffer.append`, `response.output_audio.delta` plays back,
 * transcript deltas surface as captions, and `speech_started` (barge-in)
 * clears the playback queue.
 */
export class VoiceRealtimeSession {
  #options: VoiceRealtimeSessionOptions;
  #socket: WebSocket | null = null;
  #audio: VoiceRealtimeAudio;
  #stopped = false;
  #active = false;
  #audioStarted = false;
  /** Whether this session claimed the page load's greeting — the gap between
   *  activation and the greeting's first audio then reads as thinking, not as
   *  an idle microphone. */
  #greetClaimed = false;
  readonly #screenSelection: VoiceScreenSelectionTracker;
  #meterId: number | null = null;
  #resolveStart: (() => void) | null = null;
  #rejectStart: ((error: Error) => void) | null = null;

  constructor(options: VoiceRealtimeSessionOptions) {
    this.#options = options;
    this.#screenSelection = new VoiceScreenSelectionTracker(options.screenSelection);
    this.#audio = new VoiceRealtimeAudio({
      onPlaybackComplete: (itemId) => {
        this.#sendControlEvent({ type: 'voice.playback.completed', itemId });
        if (!this.#audio.hasPlayback()) {
          this.#options.onState?.('listening');
        }
      },
    });
  }

  async start(): Promise<void> {
    this.#options.onState?.('connecting');
    const socket = new WebSocket(buildVoiceWsUrl(this.#options.getAgentSessionId()));
    this.#socket = socket;
    const active = new Promise<void>((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
    socket.addEventListener('open', () => this.#sendInitialize(socket));
    socket.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        this.#handleServerEvent(ev.data);
      }
    });
    socket.addEventListener('close', () => {
      if (!this.#active) {
        this.#rejectStart?.(new Error('voice connection closed before activation'));
      }
      if (!this.#stopped) {
        void this.stop();
      }
      this.#options.onClose?.();
    });
    socket.addEventListener('error', () => {
      this.#options.onError?.('voice connection failed');
      this.#rejectStart?.(new Error('voice connection failed'));
    });

    await active;
  }

  #startMeter(): void {
    const meter = () => {
      realtimeVoiceLevels.input = this.#audio.level();
      realtimeVoiceLevels.output = this.#audio.playbackLevel();
      this.#meterId = requestAnimationFrame(meter);
    };
    this.#meterId = requestAnimationFrame(meter);
  }

  async #prepareAudio(socket: WebSocket): Promise<void> {
    if (this.#audioStarted || this.#stopped) {
      return;
    }
    this.#audioStarted = true;
    try {
      await this.#audio.start((base64Pcm) => {
        if (this.#active && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Pcm }));
        }
      });
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('voice connection closed while preparing audio');
      }
      this.#greetClaimed = claimFirstVoiceOpen();
      socket.send(
        JSON.stringify({ ...this.#screenSelection.activate(), greet: this.#greetClaimed }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.#rejectStart?.(reason);
      void this.stop();
    }
  }

  level(): number {
    return this.#audio.level();
  }

  setMuted(muted: boolean): void {
    this.#audio.setMuted(muted);
  }

  updateScreen(selection: BrowserVoiceScreenSelection): void {
    const event = this.#screenSelection.update(selection);
    if (event && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(event));
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#meterId !== null) {
      cancelAnimationFrame(this.#meterId);
      this.#meterId = null;
    }
    realtimeVoiceLevels.input = 0;
    realtimeVoiceLevels.output = 0;
    if (this.#socket) {
      if (this.#socket.readyState === WebSocket.OPEN) {
        this.#socket.send(JSON.stringify({ type: 'voice.control', action: 'end' }));
      }
      if (this.#socket.readyState < WebSocket.CLOSING) {
        this.#socket.close();
      }
    }
    this.#socket = null;
    await this.#audio.stop();
    this.#options.onState?.('idle');
  }

  /**
   * Starts the attachment protocol once the socket opens. The server does not
   * admit microphone audio until it has configured the provider and seeded
   * durable session context.
   */
  #sendInitialize(socket: WebSocket): void {
    socket.send(
      JSON.stringify({ type: 'voice.initialize', memories: this.#options.memories ?? [] }),
    );
  }

  #handleServerEvent(raw: string): void {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(event) || typeof event['type'] !== 'string') {
      return;
    }
    switch (event['type']) {
      case 'voice.context_ready':
        if (this.#socket) {
          void this.#prepareAudio(this.#socket);
        }
        return;
      case 'voice.active':
        if (!this.#active) {
          this.#active = true;
          this.#startMeter();
          this.#options.onState?.(this.#greetClaimed ? 'thinking' : 'listening');
          this.#resolveStart?.();
          this.#resolveStart = null;
          this.#rejectStart = null;
        }
        return;
      case 'response.output_audio.delta':
        if (
          typeof event['delta'] === 'string' &&
          typeof event['item_id'] === 'string' &&
          typeof event['content_index'] === 'number'
        ) {
          this.#audio.enqueuePlayback(event['item_id'], event['content_index'], event['delta']);
          this.#options.onState?.('speaking');
        }
        return;
      case 'response.output_audio.done':
        if (typeof event['item_id'] === 'string') {
          this.#audio.markPlaybackInputDone(event['item_id']);
        }
        return;
      case 'input_audio_buffer.speech_started':
        {
          const interruption = this.#audio.clearPlayback();
          for (const itemId of interruption.completedItemIds) {
            this.#sendControlEvent({ type: 'voice.playback.completed', itemId });
          }
          for (const truncation of interruption.truncations) {
            this.#sendControlEvent({
              type: 'voice.playback.truncate',
              itemId: truncation.itemId,
              contentIndex: truncation.contentIndex,
              audioEndMs: truncation.audioEndMs,
            });
          }
        }
        this.#options.onState?.('listening');
        return;
      case 'input_audio_buffer.speech_stopped':
        // VAD closed the visitor's utterance — the model is now processing it.
        this.#options.onState?.('thinking');
        return;
      case 'response.output_audio_transcript.delta':
        if (typeof event['delta'] === 'string') {
          this.#options.onAssistantCaption?.(event['delta']);
        }
        return;
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof event['delta'] === 'string') {
          this.#options.onUserCaption?.(event['delta']);
        }
        return;
      case 'voice.state':
        if (isVoiceRealtimeState(event['state'])) {
          this.#options.onState?.(event['state']);
        }
        return;
      case 'voice.run':
        if (typeof event['busy'] === 'boolean') {
          this.#options.onRunBusy?.(event['busy']);
        }
        return;
      case 'voice.error':
        this.#options.onError?.(typeof event['message'] === 'string' ? event['message'] : '');
        return;
      case 'voice.memory':
        if (typeof event['summary'] === 'string') {
          this.#options.onMemory?.(event['summary']);
        }
        return;
      default:
        return;
    }
  }

  #sendControlEvent(event: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(event));
    }
  }
}

function isVoiceRealtimeState(value: unknown): value is VoiceRealtimeState {
  return (
    value === 'idle' ||
    value === 'connecting' ||
    value === 'listening' ||
    value === 'thinking' ||
    value === 'speaking' ||
    value === 'building'
  );
}

/** Session wired to AgentAuth for the agent session id — mirrors `createWebSocketClient`. */
export function createVoiceRealtimeSession(
  options: Omit<VoiceRealtimeSessionOptions, 'getAgentSessionId'>,
): VoiceRealtimeSession {
  return new VoiceRealtimeSession({
    ...options,
    getAgentSessionId: () => AgentAuth.agentSessionId,
  });
}
