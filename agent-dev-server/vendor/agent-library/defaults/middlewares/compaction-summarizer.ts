import type { LanguageModelV3Message } from '@ai-sdk/provider';
import { hasAgentplaceType, getTextContent } from '../../kernel/utils/message-parts.ts';

// =============================================================================
// Shared summarization prompts
// =============================================================================

/**
 * Prefix on both summarization prompts.
 *
 * Measured on the production narrative from QA agent `ys5hgxyvkpwy`:
 * `gemini-3.6-flash` returned an EMPTY response (`finishReason:
 * MALFORMED_FUNCTION_CALL`) in 8 of 16 live calls without this text and 0 of 16
 * with it, at two input sizes. The rate scales with input size — 0/4 at 12K
 * chars, 2-3/6 at 60K — so it bites hardest exactly when compaction matters
 * most.
 *
 * No tools are declared on the request; this stops the model attempting one
 * regardless. The second sentence addresses the other face of the same failure:
 * the input is a transcript, and a transcript's most probable continuation is
 * more transcript, which is what produced the narrative-echo summaries.
 *
 * Roo Code and Pi ship the same guard, arrived at independently.
 */
const NO_TOOLS_GUARD = `CRITICAL: This is a summarization-only request. DO NOT call any tools or functions. DO NOT continue the conversation. Respond with the structured summary as plain text only.

`;

export const INITIAL_SUMMARY_PROMPT = `${NO_TOOLS_GUARD}Summarize the conversation above as a structured checkpoint for another LLM to continue.

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements or preferences mentioned]

## Progress
### Done
- [x] [Completed tasks with file paths]
### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered actions]

## Files
- Modified: path/to/file.ts (what changed)
- Read: path/to/other.ts (why)

## Critical Context
- [Data, patterns, or constraints needed to continue]

Keep concise. Preserve exact file paths, function names, and error messages.`;

/**
 * The update path restates the FULL template rather than saying "use the same
 * format as the previous summary".
 *
 * Deferring to the example does not work. Reproduced against the live model on
 * the production narrative that failed for QA agent `ys5hgxyvkpwy`
 * (`packages/server/src/__integration__/summarizer-live.itest.ts`): the update
 * path echoed the transcript back — `[Tool call: …]`, `[Assistant thinking] …`,
 * no markdown structure — even when handed a well-formed previous summary. The
 * initial prompt, which states the template, produced a clean summary from the
 * same input every time.
 *
 * The old wording also opened with "The messages above are NEW conversation
 * messages" while being sent as a SYSTEM prompt, with the narrative below it
 * inside the user message — describing a layout the request does not have.
 * A weak instruction over transcript-shaped input gets continued, not
 * summarized.
 */
export const UPDATE_SUMMARY_PROMPT = `${NO_TOOLS_GUARD}You are given an existing summary in <previous-summary> tags, followed by NEW conversation messages.

Produce an UPDATED summary that merges the two. Output the structure below and nothing else — do not repeat, quote, or continue the conversation transcript.

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements or preferences mentioned]

## Progress
### Done
- [x] [Completed tasks with file paths]
### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered actions]

## Files
- Modified: path/to/file.ts (what changed)
- Read: path/to/other.ts (why)

## Critical Context
- [Data, patterns, or constraints needed to continue]

Merge rules:
- PRESERVE information from the previous summary that is still true
- ADD new progress, decisions, and context from the new messages
- MOVE completed items from "In Progress" to "Done"
- UPDATE "Next Steps" to reflect current progress
- DROP items that are no longer relevant

Keep concise. Preserve exact file paths, function names, and error messages.`;

// =============================================================================
// Shared extraction utility
// =============================================================================

/**
 * Walk conversation history and return the text of the first
 * `compaction-summary` message, or `null` if none exists.
 *
 * Works with both `LanguageModelV3Message` and `ModelMessage` — the two
 * are structurally compatible for the fields we inspect.
 */
export function extractCompactionSummary(history: unknown[]): string | null {
  for (const msg of history) {
    if (hasAgentplaceType(msg as LanguageModelV3Message, 'compaction-summary')) {
      const text = getTextContent(msg as LanguageModelV3Message);
      return text || null;
    }
  }
  return null;
}
