import { isRecord } from '../../util/type-guards.ts';

/**
 * The strictest provider's acceptance rules, applied to an outgoing request.
 *
 * `ScriptedModel` accepts any prompt, so until now the lab happily ran requests
 * the real OpenAI Responses API would have rejected — every duplication bug this
 * year was such a request, and the lab reported success on all of them. Checking
 * here re-grades every scenario that already exists rather than only enabling
 * new ones.
 *
 * Deliberately the STRICTEST contract regardless of which provider a scenario
 * names. A prompt that only survives because Claude and Gemini are lenient is
 * not a prompt we want to ship — that leniency is exactly why these defects
 * presented as GPT-only and took months to find.
 *
 * Rules and their provenance:
 *  - duplicate tool-call id in one request → OpenAI `Duplicate item found with
 *    id …`; observed in production on gpt-5.6-sol.
 *  - unpaired call / orphan result → Anthropic `'tool_use' ids were found
 *    without 'tool_result' blocks immediately after`; endemic across SDKs.
 *  - more than 4 cache breakpoints → hard provider limit, a 5th is a 400.
 * See docs/history-architecture/external-practice.md.
 *
 * Lives in agent-library rather than the lab so production and builder-lab share
 * ONE implementation. Two copies of "is this prompt valid" would drift, and a
 * detector that disagrees with the thing it is meant to guard is worse than no
 * detector — see the one-detector-path rule in scripts/builder-lab/AGENTS.md.
 */

export type ContractViolation = { code: string; message: string };

/**
 * Tool definitions render at position 0 of the request, so adding, removing or
 * reordering a tool invalidates the ENTIRE cache — tools, system and messages
 * alike. Anthropic documents this as tiered invalidation and it is the most
 * expensive cache mistake available, yet it is invisible to prefix-stability
 * metrics because the churn happens before the messages they measure.
 *
 * Compares the serialized tool set across a run's requests. Manus's answer to
 * the same problem is to mask tool logits rather than change the tool list —
 * see docs/history-architecture/external-practice.md.
 */
export function checkToolDefinitionStability(
  calls: readonly { options: { tools?: unknown } }[],
): ContractViolation[] {
  if (calls.length < 2) return [];
  const violations: ContractViolation[] = [];
  const first = JSON.stringify(calls[0].options.tools ?? null);
  for (let i = 1; i < calls.length; i++) {
    const current = JSON.stringify(calls[i].options.tools ?? null);
    if (current !== first) {
      violations.push({
        code: 'TOOL_DEFINITIONS_CHANGED',
        message: `request ${i + 1}: the tool set differs from request 1 — tools render at position 0, so this invalidates the whole cache for every later request`,
      });
      break;
    }
  }
  return violations;
}

export type ProviderContractOptions = {
  /**
   * Reject a tool-call id that appears twice anywhere in one request.
   *
   * OFF by default, and that default is a finding rather than a shortcut.
   * Providers that mint per-response ids (Bedrock Mantle, `idStyle: 'mantle'`)
   * legitimately produce the same id in turn 1's and turn 2's history, so both
   * land in one request on every multi-turn conversation — and our fleet runs
   * those successfully, so the providers we use tolerate it. AGE-378 exists to
   * fix the internal dedup and offload-path collisions this causes, not a
   * provider rejection.
   *
   * The production error that looked like this (`Duplicate item found with id
   * rs_…`, QA agent `llq6omwlcd6t`) was about duplicate *reasoning item* ids,
   * not tool-call ids.
   *
   * Turn it on to model an endpoint that does enforce per-request uniqueness.
   * Leaving it on by default would have flagged normal production traffic —
   * exactly the false-confidence failure this contract exists to avoid, in
   * the opposite direction.
   */
  strictToolCallIdUniqueness?: boolean;
};

const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The subset of a message this contract actually reads.
 *
 * Deliberately structural rather than `LanguageModelV3Message`, so the SAME
 * implementation can be applied to a provider-level prompt at the send boundary
 * AND to core `ModelMessage[]` captured earlier in the loop (`prepareStep`,
 * which is what production step dumps contain). Both shapes satisfy this, so
 * measuring the contract against real recorded traffic needs no cast and no
 * second copy of the rules.
 */
export interface ContractMessage {
  role: string;
  content?: unknown;
  providerOptions?: unknown;
}

function partsOf(message: ContractMessage): Record<string, unknown>[] {
  return Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

function hasCacheBreakpoint(message: ContractMessage): boolean {
  const providerOptions = message.providerOptions;
  if (!isRecord(providerOptions)) return false;
  const bedrock = providerOptions['bedrock'];
  if (isRecord(bedrock) && 'cachePoint' in bedrock) return true;
  for (const key of ['anthropic', 'openrouter']) {
    const namespace = providerOptions[key];
    if (isRecord(namespace) && 'cacheControl' in namespace) return true;
  }
  return false;
}

/**
 * How much of the contract's subject matter a prompt actually contained.
 *
 * "Zero violations" is only meaningful alongside this. Most rules here concern
 * tool-call pairing, so a prompt set with no tool parts — or a caller passing a
 * message shape whose parts this module fails to read — produces a clean result
 * for the wrong reason. Report coverage next to any zero before trusting it.
 */
export function summarizeContractCoverage(prompt: readonly ContractMessage[]): {
  toolCalls: number;
  toolResults: number;
} {
  let toolCalls = 0;
  let toolResults = 0;
  for (const message of prompt) {
    for (const part of partsOf(message)) {
      if (part['type'] === 'tool-call') toolCalls++;
      if (part['type'] === 'tool-result') toolResults++;
    }
  }
  return { toolCalls, toolResults };
}

/**
 * Returns every way this prompt violates the contract. Empty means a strict
 * provider would accept it.
 */
export function checkProviderContract(
  prompt: readonly ContractMessage[],
  options: ProviderContractOptions = {},
): ContractViolation[] {
  const messages = prompt;
  const violations: ContractViolation[] = [];

  const callIdFirstIndex = new Map<string, number>();
  const resultIds = new Map<string, number>();
  let breakpoints = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (hasCacheBreakpoint(message)) breakpoints++;

    if (message.role === 'tool') {
      const previous = i > 0 ? messages[i - 1].role : undefined;
      if (previous !== 'assistant' && previous !== 'tool') {
        violations.push({
          code: 'TOOL_AFTER_NON_ASSISTANT',
          message: `msg[${i}]: role 'tool' follows ${previous ?? 'start of prompt'} — a tool result must follow its assistant message`,
        });
      }
    }

    for (const part of partsOf(message)) {
      const id = part['toolCallId'];
      if (typeof id !== 'string') continue;
      if (part['type'] === 'tool-call') {
        const first = callIdFirstIndex.get(id);
        if (first !== undefined) {
          if (options.strictToolCallIdUniqueness === true) {
            violations.push({
              code: 'DUPLICATE_TOOL_CALL_ID',
              message: `msg[${i}]: tool-call id ${id} already used at msg[${first}] — an endpoint enforcing per-request uniqueness rejects this`,
            });
          }
        } else {
          callIdFirstIndex.set(id, i);
        }
      }
      if (part['type'] === 'tool-result') {
        resultIds.set(id, i);
      }
    }
  }

  for (const [id, index] of resultIds) {
    if (!callIdFirstIndex.has(id)) {
      violations.push({
        code: 'ORPHAN_TOOL_RESULT',
        message: `msg[${index}]: tool-result ${id} has no matching tool-call in this request`,
      });
    }
  }
  for (const [id, index] of callIdFirstIndex) {
    if (!resultIds.has(id)) {
      const hasLaterNonToolContent = messages
        .slice(index + 1)
        .some((m) => m.role === 'assistant' || m.role === 'user');
      if (hasLaterNonToolContent) {
        violations.push({
          code: 'UNPAIRED_TOOL_CALL',
          message: `msg[${index}]: tool-call ${id} has no tool-result before the conversation moves on`,
        });
      }
    }
  }

  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    violations.push({
      code: 'TOO_MANY_CACHE_BREAKPOINTS',
      message: `${breakpoints} cache breakpoints — the provider limit is ${MAX_CACHE_BREAKPOINTS} and a 5th is a 400`,
    });
  }

  const systemIndices = messages.flatMap((m, i) => (m.role === 'system' ? [i] : []));
  if (systemIndices.length > 1) {
    violations.push({
      code: 'MULTIPLE_SYSTEM_MESSAGES',
      message: `system messages at ${systemIndices.join(', ')} — at most one, first`,
    });
  } else if (systemIndices.length === 1 && systemIndices[0] !== 0) {
    violations.push({
      code: 'SYSTEM_NOT_FIRST',
      message: `system message at msg[${systemIndices[0]}] — must be first`,
    });
  }

  return violations;
}
