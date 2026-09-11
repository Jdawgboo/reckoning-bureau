/** Deployed-runtime voice session grounding. */
import { ContentType, type AgentContent } from '../bl/agent/agent-library.ts';
import type { MemoryEntry } from '../types.ts';
import { formatRelativeAge } from '../util/relative-age.ts';

const MAX_GROUNDING_CHARS = 4_000;
const MAX_CAPABILITY_PURPOSE_CHARS = 100;
const MAX_MEMORY_ITEMS = 15;
const MAX_MEMORY_ENTRY_CHARS = 200;

export interface DeployedGrounding {
  text: string;
  /** True when the session already has conversation history (the voice then waits instead of greeting). */
  hasHistory: boolean;
}

/** One on-screen surface the deployed agent can render — derived from the
 *  agent's own contract catalog, never hand-authored. */
export interface CapabilityCard {
  component: string;
  purpose: string;
}

/**
 * Grounding injected at voice session start: the agent's own render surfaces
 * and saved visitor notes. No runtime identity, business facts, or conversation history: raw
 * instruction text never reaches the model's mouth (`ResponseSpeechPolicy` is
 * the only path to spoken content), and prior turns are seeded into the
 * conversation ledger instead (`VoiceContextProjector`, replayed on connect)
 * rather than repeated here. Hard character cap; `hasHistory` reports whether
 * prior conversation exists, driving the greeting-vs-welcome-back choice.
 */
export function buildDeployedGrounding(params: {
  hasHistory: boolean;
  /** This agent's own render surfaces, derived from its contract catalog —
   *  never hand-authored. Omitted or empty → section omitted entirely. */
  capabilities?: CapabilityCard[];
  /**
   * The visitor's saved memory-bank notes, if already known at connect time.
   * In practice these arrive from the client only after the voice socket is
   * open (`voice.initialize`), well after this function has already run — see
   * `VoiceGateway`, which injects `memoryBankSection` directly in that case.
   * This param exists for the rare case a caller already has them, and for
   * testing the section's shape/limits through the same code path.
   */
  memories?: MemoryEntry[];
  /** Clock reference for relative-age rendering; defaults to `Date.now()`. */
  now?: number;
}): DeployedGrounding {
  const { hasHistory, capabilities, memories, now } = params;

  const parts = [
    capabilityCardSection(capabilities ?? []),
    memoryBankSection(memories ?? [], now),
  ].filter(Boolean);

  return {
    text: parts.join('\n\n').slice(0, MAX_GROUNDING_CHARS),
    hasHistory,
  };
}

export function hasVoiceConversationHistory(
  contents: AgentContent[],
  spokenChannel: string,
): boolean {
  return contents.some(
    (content) =>
      content.type === ContentType.Text &&
      content.isReasoning !== true &&
      content.content.trim() !== '' &&
      (content.hidden !== true || content.channel === spokenChannel),
  );
}

/**
 * Renders the agent's own render surfaces as a spoken-model-facing fact
 * sheet, one line per component. Derived entirely from the contract
 * catalog's `purpose` text (trimmed) — this is how the voice model learns
 * what forwarding a request can put on the visitor's screen, closing the
 * gap that otherwise leads it to guess (and wrongly deny) what's possible.
 */
function capabilityCardSection(capabilities: CapabilityCard[]): string {
  if (capabilities.length === 0) {
    return '';
  }
  const lines = capabilities.map(
    (card) => `- ${card.component} — ${truncate(card.purpose, MAX_CAPABILITY_PURPOSE_CHARS)}`,
  );
  return `ON-SCREEN CAPABILITIES (rendered on the visitor's screen when you forward a request):\n${lines.join('\n')}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Renders the visitor's own saved memory-bank notes (captured earlier by the
 * `persistToMemoryBank` tool, or by voice's own `remember_this`) as a
 * spoken-model-facing fact sheet. This function only reads the bank in — it
 * never writes to it. Belt-and-braces cap to the newest 15
 * entries even though the client already caps `MemoryStore` at 15; each
 * entry is trimmed so one oversized note cannot blow the grounding budget.
 * Each line is prefixed with its relative age (e.g. `- (3 weeks ago) …`) so
 * the model can discount stale notes — `now` defaults to `Date.now()` but is
 * injectable for deterministic tests.
 */
export function memoryBankSection(memories: MemoryEntry[], now: number = Date.now()): string {
  if (memories.length === 0) {
    return '';
  }
  const lines = memories
    .slice(-MAX_MEMORY_ITEMS)
    .map(
      (memory) =>
        `- (${formatRelativeAge(memory.timestamp, now)}) ${truncate(memory.summary, MAX_MEMORY_ENTRY_CHARS)}`,
    );
  return `What the visitor has told you before (their own saved notes — use naturally, never recite unprompted):\n${lines.join('\n')}`;
}
