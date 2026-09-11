/**
 * One voice attachment's projection of what was actually said, in the shape the
 * durable session planes accept.
 *
 * Three properties are load-bearing, and each exists because a simpler shape
 * was tried and lost something:
 *
 * 1. **One batch per caller input, not one per output item.** A caller turn may
 *    be answered by several spoken outputs whose playback settles out of order.
 *    Writing each as it settles files the agent's answer before the question it
 *    answers, so the whole turn is projected once, when every obligation on it
 *    has settled.
 *
 * 2. **Batches are drained in the order their turns began.** ASR, playback
 *    acknowledgement, and delegation settle independently, so a later turn is
 *    routinely ready first. Appending it first would reorder the conversation.
 *
 * 3. **Identity is attachment-scoped, never provider-scoped.** Above the
 *    rotation seam a provider's `turn_1` recurs once per connection, so provider
 *    ids cannot key durable items. This log mints its own, which is what the
 *    durable `messageId` is derived from; provider ids stay in logs, where they
 *    correlate with the provider's own.
 */

import { getVoiceLogger } from './util/logger.ts';

const logger = getVoiceLogger();

/** What a spoken output was: a caller's answer, or one of the out-of-band kinds. */
export type VoiceSpeechKind =
  | 'user-turn'
  | 'greeting'
  | 'admission'
  | 'progress'
  | 'liveness'
  | 'relay';

/** How much of one spoken output the listener is known to have heard. */
export type SpokenDeliveryStatus = 'full' | 'partial' | 'unconfirmed';

export interface SpokenDelivery {
  /** Attachment-scoped session identity — process-local correlation only. */
  providerSessionId: string;
  inputItemId?: string;
  outputItemId: string;
  kind: VoiceSpeechKind;
  status: SpokenDeliveryStatus;
  text: string;
  /** The AgentRun this speech belongs to, when it belongs to one. */
  runId?: string;
  audioEndMs?: number;
}

export type VoiceInputTranscription = { status: 'completed'; text: string } | { status: 'failed' };

/** What became of the caller's request: answered here, or handed to an AgentRun. */
export type VoiceTurnRoute =
  | { status: 'local' }
  | { status: 'local-failed' }
  | { status: 'rejected' }
  | { status: 'delegated-started'; runId: string }
  | { status: 'delegated-queued'; runId: string };

export type VoiceHistoryBatch =
  | {
      kind: 'user-turn';
      providerSessionId: string;
      inputItemId: string;
      transcription: VoiceInputTranscription;
      route: VoiceTurnRoute;
      deliveries: SpokenDelivery[];
    }
  | {
      kind: 'scheduled';
      providerSessionId: string;
      deliveries: SpokenDelivery[];
    };

export interface VoiceHistoryLogDeps {
  /** Attachment-scoped identity carried on every batch. */
  sessionId: string;
  /** Writes one batch to the durable session planes. Awaited before it settles. */
  emit: (batch: VoiceHistoryBatch) => Promise<void> | void;
  /** Reported once per failed write, so continuity degradation is visible. */
  onWriteFailed?: (error: unknown) => void;
}

interface PendingDelivery {
  outputItemId: string;
  order: number;
  kind: VoiceSpeechKind;
  settled: boolean;
  status: SpokenDeliveryStatus;
  text: string;
  runId?: string;
  audioEndMs?: number;
}

interface UserTurnRecord {
  kind: 'user-turn';
  ordinal: number;
  inputItemId: string;
  transcription: VoiceInputTranscription | { status: 'pending' };
  route: VoiceTurnRoute | { status: 'undecided' };
  providerTerminal: boolean;
  deliveries: PendingDelivery[];
  submitted: boolean;
}

interface ScheduledRecord {
  kind: 'scheduled';
  ordinal: number;
  providerTerminal: boolean;
  deliveries: PendingDelivery[];
  submitted: boolean;
}

type HistoryRecord = UserTurnRecord | ScheduledRecord;

export class VoiceHistoryLog {
  readonly #deps: VoiceHistoryLogDeps;
  readonly #records = new Map<number, HistoryRecord>();
  /** Which record a live turn's output belongs to. */
  readonly #recordByTurnId = new Map<string, HistoryRecord>();
  #ordinalCounter = 0;
  #deliveryCounter = 0;
  #inputCounter = 0;
  #nextSubmission = 1;
  #currentUserTurn: UserTurnRecord | null = null;
  /** Writes emitted and not yet settled — what `dispose` has to wait for. */
  readonly #inflight = new Set<Promise<void>>();
  #disposed = false;

  constructor(deps: VoiceHistoryLogDeps) {
    this.#deps = deps;
  }

  /**
   * A caller utterance entered the conversation. Any earlier user turn stops
   * collecting outputs here: whatever is spoken from now on answers this one.
   */
  beginUserTurn(inputItemId?: string): void {
    if (this.#disposed) {
      return;
    }
    this.#inputCounter += 1;
    const record: UserTurnRecord = {
      kind: 'user-turn',
      ordinal: this.#nextOrdinal(),
      inputItemId: inputItemId ?? `input_${this.#inputCounter}`,
      transcription: { status: 'pending' },
      route: { status: 'undecided' },
      providerTerminal: false,
      deliveries: [],
      submitted: false,
    };
    this.#records.set(record.ordinal, record);
    this.#currentUserTurn = record;
  }

  /**
   * The caller's words, attributed by the item they belong to when the
   * provider keys them. Nova's FINAL transcript lands seconds after the turn
   * it describes — routinely after the NEXT caller turn has begun — so
   * "whichever turn is current" would file one caller's words as another's.
   * An unkeyed transcript still falls back to the current turn, which is all
   * an adapter that cannot key them can honestly offer.
   */
  noteTranscript(text: string, callerItemId?: string): void {
    const record = this.#turnForTranscript(callerItemId);
    if (record?.transcription.status !== 'pending') {
      return;
    }
    record.transcription = { status: 'completed', text };
    this.#drain();
  }

  #turnForTranscript(callerItemId: string | undefined): UserTurnRecord | null {
    if (callerItemId === undefined) {
      return this.#currentUserTurn;
    }
    for (const record of this.#records.values()) {
      if (record.kind === 'user-turn' && record.inputItemId === callerItemId) {
        return record;
      }
    }
    return null;
  }

  /** No transcript will arrive — the provider cannot transcribe, or it failed. */
  failTranscription(): void {
    const record = this.#currentUserTurn;
    if (record?.transcription.status !== 'pending') {
      return;
    }
    record.transcription = { status: 'failed' };
    this.#drain();
  }

  noteRoute(route: VoiceTurnRoute): void {
    const record = this.#currentUserTurn;
    if (record?.route.status !== 'undecided') {
      return;
    }
    record.route = route;
    this.#drain();
  }

  /** A turn the provider opened. Out-of-band speech gets a record of its own. */
  noteSpeechOpened(turnId: string, kind: VoiceSpeechKind): void {
    if (this.#disposed || this.#recordByTurnId.has(turnId)) {
      return;
    }
    const record = kind === 'user-turn' ? this.#currentUserTurn : this.#openScheduledRecord();
    if (!record) {
      return;
    }
    this.#deliveryCounter += 1;
    record.deliveries.push({
      outputItemId: turnId,
      order: this.#deliveryCounter,
      kind,
      settled: false,
      status: 'unconfirmed',
      text: '',
    });
    this.#recordByTurnId.set(turnId, record);
  }

  /** How much of that turn the listener heard, and what it said. */
  noteSpeechSettled(
    turnId: string,
    settlement: {
      status: SpokenDeliveryStatus;
      text: string;
      runId?: string;
      audioEndMs?: number;
    },
  ): void {
    const record = this.#recordByTurnId.get(turnId);
    const delivery = record?.deliveries.find((entry) => entry.outputItemId === turnId);
    if (!record || !delivery || delivery.settled) {
      return;
    }
    delivery.settled = true;
    delivery.status = settlement.status;
    delivery.text = settlement.text;
    delivery.runId = settlement.runId;
    delivery.audioEndMs = settlement.audioEndMs;
    if (record.kind === 'scheduled') {
      record.providerTerminal = true;
    }
    this.#recordByTurnId.delete(turnId);
    this.#drain();
  }

  /**
   * The caller's turn has no further obligations: its response finished and no
   * tool work is still deciding where the request went.
   */
  noteUserTurnTerminal(): void {
    const record = this.#currentUserTurn;
    if (!record) {
      return;
    }
    record.providerTerminal = true;
    if (record.route.status === 'undecided') {
      record.route = { status: 'local' };
    }
    this.#drain();
  }

  /**
   * Closes the log when the attachment ends, writing what is still open rather
   * than discarding it, and resolving only once every write has settled.
   *
   * A call does not wait for its last turn to settle before it drops, and a
   * conversation whose final exchange is missing from history reads as one that
   * never happened. Everything unsettled is recorded as what it truthfully is:
   * speech whose delivery was never confirmed, and a caller turn whose
   * transcript never arrived.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    for (const record of this.#records.values()) {
      for (const delivery of record.deliveries) {
        if (!delivery.settled) {
          delivery.settled = true;
          delivery.status = 'unconfirmed';
        }
      }
      record.providerTerminal = true;
      if (record.kind === 'user-turn') {
        if (record.transcription.status === 'pending') {
          record.transcription = { status: 'failed' };
        }
        if (record.route.status === 'undecided') {
          record.route = { status: 'local' };
        }
      }
    }
    this.#drain();
    this.#disposed = true;
    this.#currentUserTurn = null;
    this.#recordByTurnId.clear();
    this.#records.clear();
    // The recorders acknowledge real persistence, so cleanup is not complete
    // until they have — a call that ends the process right after hang-up must
    // not race its own last exchange onto the floor. Failures were already
    // reported per write; this only awaits the settling.
    await Promise.allSettled([...this.#inflight]);
  }

  #openScheduledRecord(): ScheduledRecord {
    const record: ScheduledRecord = {
      kind: 'scheduled',
      ordinal: this.#nextOrdinal(),
      providerTerminal: false,
      deliveries: [],
      submitted: false,
    };
    this.#records.set(record.ordinal, record);
    return record;
  }

  #nextOrdinal(): number {
    this.#ordinalCounter += 1;
    return this.#ordinalCounter;
  }

  #drain(): void {
    while (!this.#disposed) {
      const record = this.#records.get(this.#nextSubmission);
      if (!record || !this.#isReady(record)) {
        return;
      }
      record.submitted = true;
      this.#records.delete(record.ordinal);
      this.#nextSubmission += 1;
      if (record.kind === 'user-turn') {
        this.#currentUserTurn = this.#currentUserTurn === record ? null : this.#currentUserTurn;
      }
      this.#submit(this.#batchFor(record));
    }
  }

  #isReady(record: HistoryRecord): boolean {
    if (record.submitted || !record.providerTerminal) {
      return false;
    }
    if (record.deliveries.some((delivery) => !delivery.settled)) {
      return false;
    }
    if (record.kind === 'scheduled') {
      return true;
    }
    return record.transcription.status !== 'pending' && record.route.status !== 'undecided';
  }

  #batchFor(record: HistoryRecord): VoiceHistoryBatch {
    const routeRunId = record.kind === 'user-turn' ? runIdOfRoute(record.route) : undefined;
    const deliveries = [...record.deliveries]
      .sort((left, right) => left.order - right.order)
      .map((delivery): SpokenDelivery => {
        const runId = delivery.runId ?? routeRunId;
        return {
          providerSessionId: this.#deps.sessionId,
          ...(record.kind === 'user-turn' ? { inputItemId: record.inputItemId } : {}),
          outputItemId: delivery.outputItemId,
          kind: delivery.kind,
          status: delivery.status,
          text: delivery.text,
          ...(runId ? { runId } : {}),
          ...(delivery.status === 'partial' && delivery.audioEndMs !== undefined
            ? { audioEndMs: delivery.audioEndMs }
            : {}),
        };
      });
    if (record.kind === 'scheduled') {
      return { kind: 'scheduled', providerSessionId: this.#deps.sessionId, deliveries };
    }
    if (record.transcription.status === 'pending' || record.route.status === 'undecided') {
      throw new Error('voice history batch requested before the caller turn became terminal');
    }
    return {
      kind: 'user-turn',
      providerSessionId: this.#deps.sessionId,
      inputItemId: record.inputItemId,
      transcription: record.transcription,
      route: record.route,
      deliveries,
    };
  }

  #submit(batch: VoiceHistoryBatch): void {
    let written: Promise<void>;
    try {
      written = Promise.resolve(this.#deps.emit(batch));
    } catch (error) {
      written = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const tracked = written.catch((error: unknown) => {
      logger.warn('[VoiceHistoryLog] a voice history batch could not be written', { error });
      this.#deps.onWriteFailed?.(error);
    });
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
  }
}

function runIdOfRoute(route: VoiceTurnRoute | { status: 'undecided' }): string | undefined {
  return route.status === 'delegated-started' || route.status === 'delegated-queued'
    ? route.runId
    : undefined;
}
