import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { SessionType } from '../sessions/types.ts';
import { isRecord } from '../util/type-guards.ts';
import { readMessageId } from './agent-state.ts';

/**
 * Blocking-tool (human-in-the-loop) history helpers.
 *
 * A blocking tool pauses by returning `status: 'pending'`; its placeholder
 * tool-result is stamped with a durable marker so pending state is
 * reconstructable from the persisted conversation history (no separate state
 * channel — multi-instance safe). On resume the placeholder is rewritten (click)
 * or left (text-bypass) and the marker cleared.
 */

export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
}

export interface ResumeToolResult {
  toolCallId: string;
  /** The user's answer; replaces the placeholder output on the click path. */
  output: string;
}

type AgentplaceProviderOptions = { agentplace?: { pendingToolCall?: boolean } };

function toolResultParts(msg: ModelMessage): Array<Record<string, unknown>> {
  if (msg.role !== 'tool' || typeof msg.content === 'string') {
    return [];
  }
  return (msg.content as Array<Record<string, unknown>>).filter((p) => p?.type === 'tool-result');
}

function isMarkedPending(part: Record<string, unknown>): boolean {
  const po = part.providerOptions as AgentplaceProviderOptions | undefined;
  return po?.agentplace?.pendingToolCall === true;
}

function clearMarker(part: Record<string, unknown>): void {
  const po = part.providerOptions as { agentplace?: Record<string, unknown> } | undefined;
  if (!po?.agentplace) {
    return;
  }
  delete po.agentplace.pendingToolCall;
  if (Object.keys(po.agentplace).length === 0) {
    delete (po as Record<string, unknown>).agentplace;
  }
}

/**
 * Mutates `messages` in place: stamps the pending marker onto tool-result parts
 * whose `toolCallId` is in `pendingIds`. Called at commit time so the marker
 * rides the persisted message.
 */
export function markPendingResults(messages: ModelMessage[], pendingIds: Set<string>): void {
  if (pendingIds.size === 0) {
    return;
  }
  for (const msg of messages) {
    for (const part of toolResultParts(msg)) {
      if (pendingIds.has(part.toolCallId as string)) {
        const existing = (part.providerOptions as { agentplace?: object } | undefined)?.agentplace;
        part.providerOptions = {
          ...(part.providerOptions as object | undefined),
          agentplace: { ...(existing ?? {}), pendingToolCall: true },
        };
      }
    }
  }
}

/**
 * The subset of a message this module needs in order to spot a pending marker.
 * Structural so callers holding provider-level messages (the compaction
 * middleware works on `LanguageModelV3Message | ModelMessage`) can ask without
 * this module taking a dependency on provider types.
 */
export interface PendingScanMessage {
  role: string;
  content?: unknown;
}

/**
 * Index of the earliest tool message still carrying an unresolved pending
 * marker, or -1 if there is none.
 *
 * Exists so compaction can refuse to collapse past an unanswered blocking call.
 * Pending state is reconstructed FROM history (`reconstructPendingFromHistory`),
 * so a placeholder that history no longer contains is a question the system has
 * forgotten it asked: `applyResumeToolResults` reports `hadPending: false` and
 * the user's answer is discarded without an error. Keeping the marker inside
 * the retained window is what makes the answer applicable when it arrives.
 */
export function firstPendingToolIndex(messages: readonly PendingScanMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) {
      continue;
    }
    for (const part of msg.content) {
      if (isRecord(part) && part['type'] === 'tool-result' && isMarkedPending(part)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Scans loaded history for marked tool-results — the cross-turn source of truth
 * for pending blocking calls.
 */
export function reconstructPendingFromHistory(history: ModelMessage[]): PendingToolCall[] {
  const out: PendingToolCall[] = [];
  for (const msg of history) {
    for (const part of toolResultParts(msg)) {
      if (isMarkedPending(part)) {
        out.push({ toolCallId: part.toolCallId as string, toolName: part.toolName as string });
      }
    }
  }
  return out;
}

/**
 * Address of one tool-result part: the containing message's assigned id plus
 * the part's position within it.
 *
 * This is what resolutions are keyed by, and the reason is AGE-378. Providers
 * recycle `toolCallId` — OpenAI-compatible engines restart at `call_1` every
 * turn — so a provider id names a question only by accident. Keying stored
 * answers on one forced a choice between two failures: replay a stale answer
 * onto whichever call now wears that id, or refuse whenever an id looked reused
 * and re-ask a question the user already answered. Entry addresses are unique
 * by construction, so neither arises.
 *
 * Returns null for messages that predate id stamping; those fall back to
 * live-only resolution, which is what they got before this existed.
 */
function entryKeyFor(message: ModelMessage, partIndex: number): string | null {
  const mid = readMessageId(message);
  return mid === null ? null : `${mid}#${partIndex}`;
}

/**
 * Resolve all marked-pending placeholders for a resume turn (pure — returns a new array).
 * - click path: a supplied result rewrites the placeholder output and clears the marker.
 * - text-bypass: no supplied result → leave the output, clear the marker so the loop proceeds.
 *
 * Fresh answers arrive keyed by `toolCallId` because that is what the UI holds;
 * they bind to a still-pending placeholder wearing that id, and a resolved call
 * elsewhere in the history under the same recycled id is not a candidate.
 * Replayed answers arrive keyed by entry address and bind only to that exact
 * part, so a stored answer can never migrate to a different question.
 */
export function rewritePendingPlaceholders(
  history: ModelMessage[],
  resumeResults: ResumeToolResult[],
  storedResolutions: ResolvedToolResults = {},
): ModelMessage[] {
  const byId = new Map(resumeResults.map((r) => [r.toolCallId, r]));
  return history.map((msg) => {
    if (toolResultParts(msg).length === 0) {
      return msg;
    }
    const content = (msg.content as Array<Record<string, unknown>>).map((part, partIndex) => {
      if (part?.type !== 'tool-result' || !isMarkedPending(part)) {
        return part;
      }
      const next: Record<string, unknown> = {
        ...part,
        providerOptions: structuredClone(part.providerOptions),
      };
      const entryKey = entryKeyFor(msg, partIndex);
      const replayed = entryKey === null ? undefined : storedResolutions[entryKey];
      if (typeof replayed === 'string') {
        next.output = { type: 'text', value: replayed };
      } else {
        const supplied = byId.get(part.toolCallId as string);
        if (supplied) {
          next.output = { type: 'text', value: supplied.output };
        }
      }
      clearMarker(next);
      return next;
    });
    return { ...msg, content } as ModelMessage;
  });
}

/**
 * Entry address (`<mid>#<partIndex>`) → click output, or null for text-bypass
 * (placeholder kept, marker cleared).
 *
 * Keyed by entry rather than `toolCallId` since Phase 6: see {@link entryKeyFor}
 * for why a provider id cannot carry this.
 */
export type ResolvedToolResults = Record<string, string | null>;

export interface ResumeOutcome {
  /** History with placeholders resolved and markers cleared (same array if nothing was pending). */
  history: ModelMessage[];
  /** Whether any marked-pending placeholders were present in the loaded history. */
  hadPending: boolean;
  /** What this resume resolved, keyed by toolCallId — durable record for replay on future loads. */
  resolutions: ResolvedToolResults;
}

/**
 * Apply a resume turn to loaded history: reconstruct pending from markers, then
 * (if any) rewrite placeholders — click rewrites the output, text-bypass leaves
 * it — and clear their markers so the built-in stop won't refire. Pending ids
 * that are ambiguous in this history (see {@link ambiguousToolCallIds}) are left
 * fully untouched and excluded from resolutions, so the question is re-asked
 * rather than answered with a stored response to a different question. Pure.
 */
export function applyResumeToolResults(
  history: ModelMessage[],
  resumeResults: ResumeToolResult[],
  storedResolutions: ResolvedToolResults = {},
): ResumeOutcome {
  const pending = reconstructPendingFromHistory(history);
  if (pending.length === 0) {
    return { history, hadPending: false, resolutions: {} };
  }
  const byId = new Map(resumeResults.map((r) => [r.toolCallId, r]));
  const resolutions: ResolvedToolResults = {};
  for (const msg of history) {
    if (toolResultParts(msg).length === 0) {
      continue;
    }
    (msg.content as Array<Record<string, unknown>>).forEach((part, partIndex) => {
      if (part?.type !== 'tool-result' || !isMarkedPending(part)) {
        return;
      }
      const entryKey = entryKeyFor(msg, partIndex);
      if (entryKey === null) {
        return;
      }
      const replayed = storedResolutions[entryKey];
      if (typeof replayed === 'string') {
        resolutions[entryKey] = replayed;
        return;
      }
      resolutions[entryKey] = byId.get(part.toolCallId as string)?.output ?? null;
    });
  }
  return {
    history: rewritePendingPlaceholders(history, resumeResults, storedResolutions),
    hadPending: true,
    resolutions,
  };
}

/**
 * Headless blocking policy: what a blocking tool's `pending` return
 * becomes when no user is present. Applied at the single pending interception
 * point in agent.service — the substituted output replaces the pending status
 * BEFORE any marker is written, so headless histories never carry unanswered
 * pending questions. 'park' (durable wait + notification) is reserved for v2.
 */
export type HeadlessBlockingPolicy = 'skip' | 'fail' | { resolve: string };

export function isHeadlessSessionType(sessionType: SessionType): boolean {
  return sessionType !== 'web';
}

export function resolveHeadlessOutput(
  policy: HeadlessBlockingPolicy,
  sessionType: SessionType,
): string {
  if (typeof policy === 'object') {
    return policy.resolve;
  }
  if (policy === 'fail') {
    return '[This action requires user input and cannot run unattended; do not retry it in this run — abort or complete the flow without it.]';
  }
  return `[No user is present in this ${sessionType} run; proceeding without user input.]`;
}
