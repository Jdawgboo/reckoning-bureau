import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { TurnProcessor, TurnProcessorState } from '../../kernel/processors/types.ts';
import { isToolCallPart, isToolResultPart } from '../../kernel/utils/message-parts.ts';
import {
  findCopyToolCallParts,
  pairToolCallOccurrences,
} from '../../kernel/utils/tool-call-pairing.ts';
import { getAgentLogger } from '../../types/logger.ts';

/** Providers that use Bedrock-style adjacency rules and signature requirements. */
const BEDROCK_PROVIDERS = new Set(['amazon-bedrock', 'anthropic']);

/**
 * Checks whether a tool-call `input` value is a broken (unparseable) JSON string.
 *
 * This happens when the model hits `max_tokens` mid-generation and the AI SDK
 * stores the incomplete JSON string as-is. Such entries break all subsequent
 * API calls because the provider cannot parse the malformed input.
 *
 * Only strings that *look* like JSON (start with `{` or `[`) are tested —
 * plain strings and object inputs are left alone.
 */
function isBrokenJsonInput(input: unknown): boolean {
  if (typeof input !== 'string') {
    return false;
  }
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return false; // valid JSON string — not broken
  } catch {
    return true; // looks like JSON but fails to parse
  }
}

/** Maximum number of tail messages to scan for split tool pairs. */
const TAIL_SCAN_SIZE = 30;

/**
 * Checks if an assistant message contains at least one non-provider-executed tool-call.
 */
function hasClientToolCallPart(msg: ModelMessage): boolean {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return false;
  return (msg.content as { type?: string; providerExecuted?: boolean }[]).some(
    (p) => p.type === 'tool-call' && !p.providerExecuted,
  );
}

type ContentPart = {
  type?: string;
  providerExecuted?: boolean;
  providerOptions?: Record<string, Record<string, unknown>>;
};

/**
 * Checks if a reasoning part is missing its Bedrock signature.
 * Bedrock requires `signature` on all thinking/reasoning blocks. When a response
 * is truncated mid-reasoning or the stream fix middleware injects a synthetic
 * reasoning-start, the part may be stored without providerOptions.bedrock.signature.
 * Sending it back causes a permanent 400: "thinking.signature: Field required".
 */
function isSignaturelessReasoning(part: ContentPart): boolean {
  return part.type === 'reasoning' && !part.providerOptions?.bedrock?.signature;
}

type ToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName?: string;
  output: unknown;
};

/**
 * Builds a global index of all tool-result parts in history, keyed by toolCallId.
 * Used by repairBedrockAdjacency to locate real results before falling back to synthetics.
 */
function buildGlobalResultIndex(history: ModelMessage[]): Map<string, ToolResultPart> {
  const index = new Map<string, ToolResultPart>();
  for (const msg of history) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ToolResultPart[]) {
      if (part.type === 'tool-result' && part.toolCallId) {
        index.set(part.toolCallId, part);
      }
    }
  }
  return index;
}

/**
 * HistoryDoctorProcessor
 *
 * Sanitizes conversation history before each turn:
 * 0. Removes excess tool-call parts (more calls than results per toolCallId) —
 *    re-persisted copies in corrupted stores that fail the SDK's order check.
 * 1. Reorders split tool pairs in recent history (user messages between
 *    tool-call and tool-result are moved past the tool message).
 * 2. Removes tool-call parts with broken/partial JSON `input` values
 *    (and their orphaned tool-result counterparts).
 * 3. [Bedrock/Anthropic only] Strips reasoning parts without Bedrock signatures (would cause 400).
 * 4. [Bedrock/Anthropic only] Fixes trailing text-only assistant message by injecting a
 *    synthetic continuation user message (Bedrock requires ending with user).
 * 5. Injects synthetic tool-result messages for tool calls that have valid
 *    input but no matching tool-result (e.g. aborted mid-execution).
 * 6. [Bedrock/Anthropic only] Repairs Bedrock-strict tool_use/tool_result adjacency.
 *
 * Returns `null` when no repairs are needed (no-op / idempotent).
 */
export class HistoryDoctorProcessor implements TurnProcessor {
  /**
   * Repair shapes the PROMPT, never the log. `design.md:20` — "One append-only log. The prompt
   * is a pure projection of it." Writing repairs back caused them to be re-committed beside the
   * originals they replaced, and put synthesised results into durable history (PROD 2026-07-30).
   */
  readonly projection = true;

  readonly #modelProvider: string | undefined;

  constructor(modelProvider?: string) {
    this.#modelProvider = modelProvider;
  }

  get #isBedrockProvider(): boolean {
    return this.#modelProvider != null && BEDROCK_PROVIDERS.has(this.#modelProvider);
  }

  /**
   * Removes re-persisted copies of tool calls (AGE-351 corruption) without ever
   * deleting a live call under provider-recycled ids (AGE-378). A call part is a
   * copy only when ALL of: it is unresolved by order-sensitive FIFO pairing with
   * tool results; an earlier call identical in (toolCallId, toolName, input) was
   * resolved; and it is not in the final message of history (a truly in-flight
   * call). Untouched messages keep their object identity; returns null when
   * nothing changed.
   */
  #dedupDuplicateToolCalls(history: ModelMessage[]): ModelMessage[] | null {
    const copyParts = findCopyToolCallParts(history);
    if (copyParts.size === 0) {
      return null;
    }

    const firstCallMessage = new Map<string, ModelMessage>();
    const result: ModelMessage[] = [];

    for (const msg of history) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }
      const kept = msg.content.filter((part) => {
        if (!isToolCallPart(part)) return true;
        if (copyParts.has(part)) return false;
        if (!firstCallMessage.has(part.toolCallId)) {
          firstCallMessage.set(part.toolCallId, msg);
        }
        return true;
      });
      if (kept.length === msg.content.length) {
        result.push(msg);
        continue;
      }
      if (kept.length > 0 && !this.#isCopyRemnant(msg, kept, firstCallMessage)) {
        result.push({ ...msg, content: kept } as ModelMessage);
      }
    }

    return result;
  }

  /**
   * True when every surviving part appears verbatim in the message holding the
   * first occurrence of a removed call — the remnant is itself a copy.
   */
  #isCopyRemnant(
    msg: ModelMessage,
    kept: unknown[],
    firstCallMessage: Map<string, ModelMessage>,
  ): boolean {
    if (!Array.isArray(msg.content)) return false;
    const removedIds = msg.content
      .filter((part) => isToolCallPart(part) && !kept.includes(part))
      .map((part) => (part as { toolCallId: string }).toolCallId);
    const originals = new Set<string>();
    for (const id of removedIds) {
      const original = firstCallMessage.get(id);
      if (!original || original === msg || !Array.isArray(original.content)) return false;
      for (const part of original.content) {
        originals.add(JSON.stringify(part));
      }
    }
    if (originals.size === 0) return false;
    return kept.every((part) => originals.has(JSON.stringify(part)));
  }

  /**
   * Scans all messages once to detect: broken JSON inputs, orphaned tool calls
   * (valid call with no FIFO-paired result — ids recycle under AGE-378, so
   * detection is per occurrence, never per id), and signatureless reasoning
   * parts (Bedrock-only).
   */
  #detectIssues(history: ModelMessage[]): {
    brokenCallParts: Set<unknown>;
    brokenResultParts: Set<unknown>;
    orphanedCallParts: Set<unknown>;
    hasSignaturelessReasoning: boolean;
  } {
    const brokenCallParts = new Set<unknown>();
    const brokenResultParts = new Set<unknown>();
    const orphanedCallParts = new Set<unknown>();
    let hasSignaturelessReasoning = false;

    for (const occurrence of pairToolCallOccurrences(history)) {
      const part = occurrence.part as { input?: unknown };
      if (isBrokenJsonInput(part.input)) {
        brokenCallParts.add(occurrence.part);
        if (occurrence.resultPart != null) {
          brokenResultParts.add(occurrence.resultPart);
        }
      } else if (!occurrence.resolved) {
        orphanedCallParts.add(occurrence.part);
      }
    }

    if (this.#isBedrockProvider) {
      for (const msg of history) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
          continue;
        }
        // Bedrock-only: signatureless reasoning blocks cause a 400
        if (msg.content.some((part) => isSignaturelessReasoning(part as ContentPart))) {
          hasSignaturelessReasoning = true;
          break;
        }
      }
    }

    return { brokenCallParts, brokenResultParts, orphanedCallParts, hasSignaturelessReasoning };
  }

  /**
   * Filters out broken tool inputs and (Bedrock-only) signatureless reasoning
   * parts. Drops messages left empty; untouched messages keep their identity.
   * When nothing needs filtering, returns a shallow copy of history.
   */
  #filterHistory(
    history: ModelMessage[],
    brokenCallParts: Set<unknown>,
    brokenResultParts: Set<unknown>,
    hasSignaturelessReasoning: boolean,
  ): ModelMessage[] {
    if (brokenCallParts.size === 0 && !hasSignaturelessReasoning) {
      return [...history];
    }

    const cleaned: ModelMessage[] = [];

    for (const msg of history) {
      if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
        cleaned.push(msg);
        continue;
      }

      if (msg.role === 'assistant') {
        const filteredContent = msg.content.filter((part) => {
          if (brokenCallParts.has(part)) {
            return false;
          }
          if (this.#isBedrockProvider && isSignaturelessReasoning(part as ContentPart)) {
            return false;
          }
          return true;
        });
        this.#pushFiltered(cleaned, msg, filteredContent);
        continue;
      }

      if (msg.role === 'tool') {
        const filteredContent = msg.content.filter((part) => !brokenResultParts.has(part));
        this.#pushFiltered(cleaned, msg, filteredContent);
        continue;
      }

      cleaned.push(msg);
    }

    return cleaned;
  }

  #pushFiltered(cleaned: ModelMessage[], msg: ModelMessage, filteredContent: unknown[]): void {
    if (!Array.isArray(msg.content) || filteredContent.length === msg.content.length) {
      cleaned.push(msg);
      return;
    }
    if (filteredContent.length > 0) {
      cleaned.push({ ...msg, content: filteredContent } as ModelMessage);
    }
  }

  /**
   * If this is a Bedrock provider and the last message is a text-only assistant
   * (no tool-calls), appends a `[continuing...]` text part if the last part is
   * reasoning, then appends a synthetic continuation user message.
   *
   * Bedrock Converse API requires the conversation to end with a user message.
   * Returns history unchanged if no fix is needed.
   */
  #fixTrailingAssistant(history: ModelMessage[]): ModelMessage[] {
    if (!this.#isBedrockProvider) return history;

    const lastMsg = history[history.length - 1];
    const lastIsTextAssistant =
      lastMsg?.role === 'assistant' &&
      Array.isArray(lastMsg.content) &&
      !(lastMsg.content as { type?: string }[]).some((p) => p.type === 'tool-call');

    if (!lastIsTextAssistant) return history;

    if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastPart = lastMsg.content[lastMsg.content.length - 1] as { type?: string };
      if (lastPart.type === 'reasoning') {
        (lastMsg.content as unknown[]).push({ type: 'text', text: '[continuing...]' });
      }
    }

    history.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>Continue from where you left off.</system-reminder>',
        },
      ],
    } as ModelMessage);

    return history;
  }

  /**
   * Injects synthetic tool-result messages for orphaned calls (valid tool-call
   * occurrence with no FIFO-paired tool-result). Keyed by part reference —
   * never by toolCallId, which recycles under AGE-378 — so exactly one
   * synthetic lands after the orphan's own message. If the next message is
   * already a tool message, appends synthetic parts to it instead of creating
   * a new one.
   */
  #injectOrphanResults(history: ModelMessage[], orphanedCallParts: Set<unknown>): ModelMessage[] {
    const result: ModelMessage[] = [];

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      result.push(msg);

      if (
        msg.role !== 'assistant' ||
        typeof msg.content === 'string' ||
        !Array.isArray(msg.content)
      ) {
        continue;
      }

      const orphansHere: { toolCallId: string; toolName: string }[] = [];
      for (const part of msg.content) {
        if (isToolCallPart(part) && orphanedCallParts.has(part)) {
          orphansHere.push({ toolCallId: part.toolCallId, toolName: part.toolName });
        }
      }

      if (orphansHere.length === 0) {
        continue;
      }

      const syntheticParts = orphansHere.map((tc) => ({
        type: 'tool-result' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { type: 'text' as const, value: 'Tool execution was cancelled.' },
      }));

      // If the next message is already a tool message, append to it instead of
      // creating back-to-back tool messages.
      const next = history[i + 1];
      if (next && next.role === 'tool' && Array.isArray(next.content)) {
        result.push({
          ...next,
          content: [...next.content, ...syntheticParts],
        } as ModelMessage);
        i++; // skip — already handled
      } else {
        result.push({
          role: 'tool',
          content: syntheticParts,
        } as ModelMessage);
      }
    }

    return result;
  }

  /**
   * Scans the tail of the history for split tool pairs: sequences where a user
   * message sits between an assistant(tool-call) and its tool(result).
   *
   * This happens when injected user messages are
   * committed into history between tool pairs. The Anthropic/Bedrock API
   * requires tool_result immediately after tool_use — a user message in between
   * causes a permanent 400 error that blocks all future messages.
   *
   * Fix: move the user message(s) past the tool message so the pair is adjacent.
   * Only scans the last TAIL_SCAN_SIZE messages to avoid touching old history.
   *
   * Returns the reordered history, or null if no splits found.
   */
  #reorderSplitToolPairs(history: ModelMessage[]): ModelMessage[] | null {
    const scanStart = Math.max(0, history.length - TAIL_SCAN_SIZE);
    let needsRepair = false;

    for (let i = scanStart; i < history.length - 1; i++) {
      if (hasClientToolCallPart(history[i]) && history[i + 1]?.role === 'user') {
        needsRepair = true;
        break;
      }
    }

    if (!needsRepair) return null;

    const result = history.slice(0, scanStart);
    const tail = history.slice(scanStart);

    let i = 0;
    while (i < tail.length) {
      const msg = tail[i];

      if (hasClientToolCallPart(msg) && i + 1 < tail.length && tail[i + 1]?.role === 'user') {
        result.push(msg);

        const displaced: ModelMessage[] = [];
        let j = i + 1;
        while (j < tail.length && tail[j].role === 'user') {
          displaced.push(tail[j]);
          j++;
        }

        if (j < tail.length && tail[j].role === 'tool') {
          result.push(tail[j]);
          result.push(...displaced);
          i = j + 1;
        } else {
          // No tool message found — push users as-is (orphan injection will handle it)
          result.push(...displaced);
          i = j;
        }
      } else {
        result.push(msg);
        i++;
      }
    }

    return result;
  }

  /**
   * Validates Bedrock-strict tool_use/tool_result adjacency on ModelMessage history.
   *
   * Simulates the Bedrock provider's `groupIntoBlocks` (which maps `tool` → `user`
   * and merges consecutive same-role messages). Finds assistant blocks where tool-calls
   * have no matching tool-result in the immediately-next user/tool block.
   *
   * For any such tool-calls:
   *   - If the real result exists elsewhere in history: relocates it adjacent to the call
   *     and removes it from its original position.
   *   - If no result exists anywhere: injects a synthetic result.
   *
   * This prevents the "synthetic + orphaned real result" double-message bug where
   * a synthetic is injected while the real result remains stranded in a later block.
   *
   * Returns the repaired history, or null if no adjacency issues found.
   */
  #repairBedrockAdjacency(history: ModelMessage[]): ModelMessage[] | null {
    type Block = { type: string; startIdx: number; endIdx: number };
    const blocks: Block[] = [];
    let currentType: string | null = null;
    let blockStart = 0;

    for (let i = 0; i < history.length; i++) {
      const bedrockType = history[i].role === 'tool' ? 'user' : history[i].role;
      if (bedrockType !== currentType) {
        if (currentType !== null) {
          blocks.push({ type: currentType, startIdx: blockStart, endIdx: i - 1 });
        }
        currentType = bedrockType;
        blockStart = i;
      }
    }
    if (currentType !== null) {
      blocks.push({ type: currentType, startIdx: blockStart, endIdx: history.length - 1 });
    }

    const globalResultIndex = buildGlobalResultIndex(history);

    type Insertion = { parts: ToolResultPart[] };
    const insertions = new Map<number, Insertion>();
    // Relocation is tracked by PART REFERENCE, never by toolCallId. Ids are not unique in this
    // history (see the pairing JSDoc above), so an id-keyed Set filtered out EVERY result sharing
    // the id — including pairs that needed no repair — while re-inserting only one. That turned a
    // survivable history into one the SDK rejects, permanently, and bricked a prod session on
    // 2026-07-30 (docs/prod-2026-07-30-missing-tool-results/).
    const relocatedParts = new Set<ToolResultPart>();

    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.type !== 'assistant') continue;

      const callIds = new Map<string, string>();
      for (let i = block.startIdx; i <= block.endIdx; i++) {
        const msg = history[i];
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          providerExecuted?: boolean;
        }[]) {
          if (part.type === 'tool-call' && part.toolCallId) {
            callIds.set(part.toolCallId, part.toolName ?? 'unknown');
          }
        }
      }
      if (callIds.size === 0) continue;

      const nextBlock = blocks[b + 1];
      if (nextBlock && nextBlock.type === 'user') {
        for (let i = nextBlock.startIdx; i <= nextBlock.endIdx; i++) {
          const msg = history[i];
          if (!Array.isArray(msg.content)) continue;
          for (const part of msg.content as { type?: string; toolCallId?: string }[]) {
            if (part.type === 'tool-result' && part.toolCallId) {
              callIds.delete(part.toolCallId);
            }
          }
        }
      }

      if (callIds.size === 0) continue;

      const parts: ToolResultPart[] = [];
      for (const [toolCallId, toolName] of callIds) {
        const realResult = globalResultIndex.get(toolCallId);
        if (realResult) {
          parts.push(realResult);
          relocatedParts.add(realResult);
        } else {
          parts.push({
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'text' as const, value: 'Tool execution was interrupted.' },
          });
        }
      }
      insertions.set(block.endIdx, { parts });
    }

    if (insertions.size === 0) return null;

    const result: ModelMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];

      if (msg.role === 'tool' && Array.isArray(msg.content) && relocatedParts.size > 0) {
        const kept = (msg.content as ToolResultPart[]).filter((p) => !relocatedParts.has(p));
        if (kept.length > 0) {
          result.push({ ...msg, content: kept } as ModelMessage);
        }
        // If all parts were relocated, drop the message entirely.
      } else {
        result.push(msg);
      }

      const insertion = insertions.get(i);
      if (insertion) {
        // If the next message is already a tool message, append to it rather than
        // creating back-to-back tool messages.
        const next = history[i + 1];
        if (next && next.role === 'tool' && Array.isArray(next.content)) {
          const nextKept = (next.content as ToolResultPart[]).filter((p) => !relocatedParts.has(p));
          result.push({
            ...next,
            content: [...nextKept, ...insertion.parts],
          } as ModelMessage);
          i++; // skip — already handled
        } else {
          result.push({ role: 'tool', content: insertion.parts } as ModelMessage);
        }
      }
    }

    return result;
  }

  async process(state: TurnProcessorState): Promise<ModelMessage[] | null> {
    const log = getAgentLogger();
    const provider = this.#modelProvider ?? 'unknown';
    let history = state.getConversationHistory();

    const deduped = this.#dedupDuplicateToolCalls(history);
    if (deduped) {
      log.info('[HistoryDoctor] removed duplicated tool calls', {
        provider,
        before: history.length,
        after: deduped.length,
      });
      history = deduped;
    }

    const reordered = this.#reorderSplitToolPairs(history);
    if (reordered) {
      log.info('[HistoryDoctor] reordered split tool pairs', {
        provider,
        before: history.length,
        after: reordered.length,
      });
      history = reordered;
    }

    const { brokenCallParts, brokenResultParts, orphanedCallParts, hasSignaturelessReasoning } =
      this.#detectIssues(history);

    // This processor runs after TurnInputProcessor, so on normal conversation turns the user
    // message is already present. The check naturally returns false when history ends with a
    // user message. It only fires for trigger/schedule turns where TurnInputProcessor adds
    // nothing (no incoming user message).
    const endsWithTextAssistant =
      this.#isBedrockProvider &&
      history.length > 0 &&
      history[history.length - 1].role === 'assistant' &&
      Array.isArray(history[history.length - 1].content) &&
      !(history[history.length - 1].content as { type?: string }[]).some(
        (p) => p.type === 'tool-call',
      );

    const needsRepair =
      deduped !== null ||
      reordered ||
      brokenCallParts.size > 0 ||
      orphanedCallParts.size > 0 ||
      endsWithTextAssistant ||
      hasSignaturelessReasoning;

    if (!needsRepair) {
      log.debug('[HistoryDoctor] no repairs needed', { provider, messageCount: history.length });
      return null;
    }

    log.info('[HistoryDoctor] repairs needed', {
      provider,
      messageCount: history.length,
      brokenIds: brokenCallParts.size,
      orphanedCalls: orphanedCallParts.size,
      endsWithTextAssistant,
      hasSignaturelessReasoning,
    });

    let result = this.#filterHistory(
      history,
      brokenCallParts,
      brokenResultParts,
      hasSignaturelessReasoning,
    );
    result = this.#fixTrailingAssistant(result);

    if (orphanedCallParts.size > 0) {
      result = this.#injectOrphanResults(result, orphanedCallParts);
    }

    if (!this.#isBedrockProvider) return result;
    const adjacencyFixed = this.#repairBedrockAdjacency(result);
    if (adjacencyFixed) log.info('[HistoryDoctor] repaired Bedrock adjacency', { provider });
    return adjacencyFixed ?? result;
  }
}
