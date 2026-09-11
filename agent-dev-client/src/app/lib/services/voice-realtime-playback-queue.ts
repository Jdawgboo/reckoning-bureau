export interface VoiceRealtimePlaybackSource {
  stop(): void;
}

interface VoiceRealtimePlaybackItem {
  contentIndex: number;
  startAt: number;
  endAt: number;
  sources: Set<VoiceRealtimePlaybackSource>;
  inputDone: boolean;
}

export interface VoiceRealtimePlaybackInterruption {
  completedItemIds: string[];
  truncations: Array<{ itemId: string; contentIndex: number; audioEndMs: number }>;
}

/** Tracks listener completion independently for every provider output item. */
export class VoiceRealtimePlaybackQueue {
  #items = new Map<string, VoiceRealtimePlaybackItem>();
  readonly #onComplete: (itemId: string) => void;

  constructor(onComplete: (itemId: string) => void) {
    this.#onComplete = onComplete;
  }

  enqueue(
    itemId: string,
    contentIndex: number,
    startAt: number,
    endAt: number,
    source: VoiceRealtimePlaybackSource,
  ): void {
    const item = this.#items.get(itemId) ?? {
      contentIndex,
      startAt,
      endAt: startAt,
      sources: new Set<VoiceRealtimePlaybackSource>(),
      inputDone: false,
    };
    item.endAt = Math.max(item.endAt, endAt);
    item.sources.add(source);
    this.#items.set(itemId, item);
  }

  markInputDone(itemId: string): void {
    const item = this.#items.get(itemId);
    if (!item) {
      return;
    }
    item.inputDone = true;
    this.#completeIfReady(itemId, item);
  }

  sourceEnded(itemId: string, source: VoiceRealtimePlaybackSource): void {
    const item = this.#items.get(itemId);
    if (!item) {
      return;
    }
    item.sources.delete(source);
    this.#completeIfReady(itemId, item);
  }

  hasPlayback(): boolean {
    return this.#items.size > 0;
  }

  clear(now: number): VoiceRealtimePlaybackInterruption {
    const completedItemIds: string[] = [];
    const truncations: VoiceRealtimePlaybackInterruption['truncations'] = [];
    const sources = new Set<VoiceRealtimePlaybackSource>();
    for (const [itemId, item] of this.#items) {
      for (const source of item.sources) {
        sources.add(source);
      }
      if (item.inputDone && now >= item.endAt) {
        completedItemIds.push(itemId);
        continue;
      }
      const playedUntil = Math.min(Math.max(now, item.startAt), item.endAt);
      truncations.push({
        itemId,
        contentIndex: item.contentIndex,
        audioEndMs: Math.max(0, Math.floor((playedUntil - item.startAt) * 1_000)),
      });
    }
    this.#items.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // AudioBufferSourceNode throws when it has already stopped.
      }
    }
    return { completedItemIds, truncations };
  }

  #completeIfReady(itemId: string, item: VoiceRealtimePlaybackItem): void {
    if (!item.inputDone || item.sources.size > 0) {
      return;
    }
    this.#items.delete(itemId);
    this.#onComplete(itemId);
  }
}
