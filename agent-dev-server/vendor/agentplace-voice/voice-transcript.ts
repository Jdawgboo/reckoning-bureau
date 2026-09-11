/**
 * The conversation, rebuilt from the facts an upstream reported, in the one
 * shape the seam can seed a new session with.
 *
 * This exists because two of three providers have no session resumption, so
 * their only continuity across a rotation is `UpstreamSessionConfig.history` —
 * and nothing else in the stack keeps a transcript. The orchestrator's own
 * history planes are a different thing: they
 * hold what the *product* said and did, and are shaped for a screen. What a
 * replayed session needs is what the *model* believes was said, in provider
 * order, which is exactly the fact stream and nothing else.
 *
 * Three properties are load-bearing:
 *
 * 1. **Turn ids are namespaced by generation.** Every adapter mints turn ids
 *    from a per-session counter (`turn_1`, `turn_2`, …), so after one rotation
 *    the new session's first turn has the same id as the old session's. Without
 *    namespacing the two merge and the replayed transcript has one utterance
 *    containing two answers.
 *
 * 2. **Position is fixed when an item is first seen, not when its text
 *    completes.** Nova's final assistant transcript arrives seconds after the
 *    audio it describes — measured at 9.0 s for a turn whose speech began at
 *    2.2 s — by which time the caller may have spoken again. Appending on
 *    arrival would file the agent's answer after the question that followed it.
 *
 * 3. **Tool activity is prose, never structure.** Gemini closes the connection
 *    with code 1007 on seeded content carrying tool-call structures, and the
 *    seam's history is `{role, text}` regardless. So a call and its result are
 *    flattened into one assistant line, which also stops a rotated model
 *    re-running work it already did.
 */

import type { UpstreamFact } from './realtime-upstream.ts';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/** A tool call and, once known, what it returned. Rendered to one prose line. */
export interface ToolExchange {
  name: string;
  args: Record<string, unknown>;
  output: string | null;
}

export interface VoiceTranscriptOptions {
  /** Conversation the first session was itself seeded with, oldest first. */
  seed?: ReadonlyArray<TranscriptEntry>;
  /**
   * Newest entries kept. Bounds a long call's replay cost — every rotation
   * re-bills the whole transcript as fresh input tokens.
   */
  maxEntries?: number;
  /** Newest bytes kept, summed over entry text. Applied after `maxEntries`. */
  maxBytes?: number;
  /** Longest tool output rendered into a line before truncation. */
  maxToolOutputChars?: number;
  /** Overrides how a tool exchange reads in the replayed transcript. */
  renderToolExchange?: (exchange: ToolExchange) => string;
}

/** Items are ordered by `seq`, which is assigned when the item is first seen. */
interface TranscriptItem {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  /** Set once a `final` fact replaced the accumulated deltas. */
  finalized: boolean;
  exchange: ToolExchange | null;
}

const DEFAULT_MAX_ENTRIES = 200;
/**
 * 100 KB. Pipecat caps Nova history at 200 KB total and 50 KB per message; half
 * of that is still far more conversation than a phone call produces, and the
 * cost of being wrong is a rejected session at the moment of rotation.
 */
const DEFAULT_MAX_BYTES = 100 * 1024;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 400;

export class VoiceTranscript {
  #seed: TranscriptEntry[];
  #items = new Map<string, TranscriptItem>();
  #callKeys = new Map<string, string>();
  #generation = 1;
  #seq = 0;
  #maxEntries: number;
  #maxBytes: number;
  #maxToolOutputChars: number;
  #renderToolExchange: (exchange: ToolExchange) => string;

  constructor(options: VoiceTranscriptOptions = {}) {
    this.#seed = (options.seed ?? []).map((entry) => ({ ...entry }));
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    this.#renderToolExchange = options.renderToolExchange ?? defaultToolExchangeLine;
  }

  /**
   * Enter a new provider session. Everything recorded from here on is keyed
   * under a fresh namespace, so the new session's `turn_1` is a different item
   * from the previous session's.
   */
  beginGeneration(): void {
    this.#generation += 1;
  }

  observe(fact: UpstreamFact): void {
    if (fact.type === 'caller.transcript') {
      this.#record(this.#callerKey(fact.callerItemId), 'user', fact.text, fact.final);
      return;
    }
    if (fact.type === 'model.text') {
      this.#record(this.#turnKey(fact.turnId), 'assistant', fact.text, fact.final);
      return;
    }
    if (fact.type === 'tool.called') {
      this.#recordToolCall(fact.callId, fact.name, fact.args);
    }
  }

  /**
   * Pair a returned result with the call it answers. Fed by the rotator from
   * `submitToolResult`, because a tool result is a method call on the session
   * rather than a fact the provider reports — so the fact stream alone cannot
   * see it, and a replayed transcript would show the agent asking questions it
   * never got answers to.
   */
  recordToolResult(callId: string, output: string): void {
    const key = this.#callKeys.get(callId);
    const item = key === undefined ? undefined : this.#items.get(key);
    if (!item?.exchange) {
      return;
    }
    item.exchange.output = truncate(output, this.#maxToolOutputChars);
    item.text = this.#renderToolExchange(item.exchange);
  }

  /**
   * The conversation, oldest first, trimmed to the configured budget.
   *
   * A trim drops the oldest entries rather than the longest, because the model
   * needs the recent turns to answer the caller's next sentence and losing the
   * opening of a long call is the least damaging omission available.
   */
  entries(): TranscriptEntry[] {
    const ordered = [...this.#items.values()]
      .sort((a, b) => a.seq - b.seq)
      .filter((item) => item.text.length > 0)
      .map((item) => ({ role: item.role, text: item.text }));
    return this.#applyBudget([...this.#seed, ...ordered]);
  }

  /** Entry count before trimming, for reporting what a rotation is carrying. */
  size(): number {
    return this.#seed.length + [...this.#items.values()].filter((i) => i.text.length > 0).length;
  }

  /**
   * The FIRST final for a key carries the complete utterance on all three
   * adapters, so it replaces the deltas accumulated under that key. A LATER one
   * is a second utterance filed under the same key, and it extends.
   *
   * All three providers produce that case, and none of them flags it. OpenAI
   * emits one `response.audio_transcript.done` per audio item and a turn is keyed
   * by response; its caller transcripts without an `item_id` all share the
   * `unattributed` key. Nova's late FINAL blocks are attributed by recency, and
   * every one of them is `confidence: 'proposed'` — so confidence cannot tell a
   * misattributed guess from a genuine second block, and a rule that dropped the
   * second would lose real speech on that provider.
   *
   * Extending is the safe side of that ambiguity: a mis-keyed final adds a line
   * the model really did say to the wrong utterance, where replacing deletes one
   * it said from the right one, and only the second loses conversation.
   */
  #record(key: string, role: 'user' | 'assistant', text: string, final: boolean): void {
    const item = this.#items.get(key) ?? this.#open(key, role);
    if (final) {
      item.text = item.finalized ? joinUtterances(item.text, text) : text;
      item.finalized = true;
      return;
    }
    if (item.finalized) {
      return;
    }
    item.text += text;
  }

  #recordToolCall(callId: string, name: string, args: Record<string, unknown>): void {
    const key = `${this.#generation}:tool:${callId}`;
    if (this.#items.has(key)) {
      return;
    }
    const exchange: ToolExchange = { name, args, output: null };
    const item = this.#open(key, 'assistant');
    item.exchange = exchange;
    item.text = this.#renderToolExchange(exchange);
    this.#callKeys.set(callId, key);
  }

  #open(key: string, role: 'user' | 'assistant'): TranscriptItem {
    this.#seq += 1;
    const item: TranscriptItem = {
      seq: this.#seq,
      role,
      text: '',
      finalized: false,
      exchange: null,
    };
    this.#items.set(key, item);
    return item;
  }

  /**
   * A caller utterance with no id is attributed to the generation as a whole:
   * only OpenAI can omit `callerItemId`, and only when the provider itself gave
   * no item id, in which case there is no way to tell two utterances apart and
   * merging them is more honest than inventing a split.
   */
  #callerKey(callerItemId: string | undefined): string {
    return `${this.#generation}:caller:${callerItemId ?? 'unattributed'}`;
  }

  #turnKey(turnId: string): string {
    return `${this.#generation}:turn:${turnId}`;
  }

  #applyBudget(entries: TranscriptEntry[]): TranscriptEntry[] {
    const capped =
      entries.length > this.#maxEntries
        ? entries.slice(entries.length - this.#maxEntries)
        : entries;
    let bytes = 0;
    let firstKept = capped.length;
    for (let index = capped.length - 1; index >= 0; index -= 1) {
      const entry = capped[index];
      if (!entry) {
        continue;
      }
      const size = Buffer.byteLength(entry.text, 'utf8');
      if (bytes + size > this.#maxBytes && firstKept < capped.length) {
        break;
      }
      bytes += size;
      firstKept = index;
    }
    return capped.slice(firstKept);
  }
}

/**
 * Reads as narration rather than as a protocol frame, so a model that decides
 * to repeat it aloud says something a caller can understand instead of leaking
 * a wire structure. Arguments are included because "I checked something" is not
 * enough to stop the model checking it again.
 */
function defaultToolExchangeLine(exchange: ToolExchange): string {
  const args = Object.keys(exchange.args).length > 0 ? ` with ${safeJson(exchange.args)}` : '';
  if (exchange.output === null) {
    return `(I used the ${exchange.name} tool${args}, and the result never came back.)`;
  }
  return `(I used the ${exchange.name} tool${args}, and it returned: ${exchange.output})`;
}

/** Two finals under one key are two utterances, so the line has to read as two. */
function joinUtterances(existing: string, addition: string): string {
  if (existing.length === 0 || addition.length === 0) {
    return `${existing}${addition}`;
  }
  return /\s$/.test(existing) ? `${existing}${addition}` : `${existing} ${addition}`;
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
