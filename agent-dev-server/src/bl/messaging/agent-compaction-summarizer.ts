import { generateText } from 'ai';
import type { ModelProvider } from '../agent/interfaces.ts';
import type { CollapseSummaryContext } from '../agent/agent-library.ts';
import type { AgentStorage } from '../../../vendor/agent-library/storage/agent-storage.ts';
import {
  INITIAL_SUMMARY_PROMPT,
  UPDATE_SUMMARY_PROMPT,
} from '../../../vendor/agent-library/defaults/middlewares/compaction-summarizer.ts';
import {
  buildCompactionHistoryPointer,
  generateSummaryWithFallback,
  nextCompactionHistoryPath,
  stripModelSummaryWrapper,
  usablePreviousSummary,
} from '../../../vendor/agent-library/defaults/middlewares/compaction-history.ts';

const SUMMARIZATION_MODEL = 'gemini-3.7-flash';
const FALLBACK_SUMMARIZATION_MODEL = 'global.anthropic.claude-sonnet-5';
const SUMMARY_MAX_OUTPUT_TOKENS = 8000;

type SummarizerModelProvider = Pick<ModelProvider, 'getModel'>;
type SummarizerStorage = Pick<AgentStorage, 'listFiles' | 'exists' | 'resolvePath' | 'writeFile'>;

export type AgentCompactionSummarizerOptions = {
  storage: SummarizerStorage;
  sessionKey?: string;
  /** Per-context history scope: 'main' or a per-invocation subagent value. */
  compactionScope: string;
};

export function buildSummarizerInput(
  serializedNarrative: string,
  previousSummary: string | null,
  historyPath: string | null,
): string {
  const previous = usablePreviousSummary(previousSummary);
  let input = previous
    ? `<previous-summary>\n${previous}\n</previous-summary>\n\n${serializedNarrative}`
    : serializedNarrative;
  if (historyPath) {
    input += `\n\n---\nThe full pre-compaction conversation history has been stored at: "${historyPath}".`;
  }
  return input;
}

/**
 * LLM-backed collapse-summary builder for CompactionMiddleware, mirroring the
 * builder's contract: numbered per-compaction history dumps under the
 * context's own scope directory, a deterministic pointer appended in code,
 * one cross-model retry on a degenerate summary, and rethrow on LLM failure
 * so the middleware's chain-preserving fallback applies. A summary rejected
 * by both models is returned bare so the middleware rejects it too.
 */
export function createAgentCompactionSummarizer(
  modelProvider: SummarizerModelProvider,
  options: AgentCompactionSummarizerOptions,
): (ctx: CollapseSummaryContext) => Promise<string> {
  const historyDir = `tool-results/compaction/${options.compactionScope}`;

  return async (ctx) => {
    try {
      let historyPath: string | null = null;
      if (options.sessionKey) {
        historyPath = await nextCompactionHistoryPath(options.storage, historyDir);
        void options.storage
          .writeFile(historyPath, Buffer.from(ctx.serializedNarrative, 'utf-8'))
          .catch((error: unknown) => {
            console.warn('[compaction-summarizer] history dump failed:', error);
          });
      }

      // See usablePreviousSummary: an invalid previous summary becomes the
      // example the model imitates, so it is dropped and the initial prompt
      // (which states the template) is used instead.
      const prompt = usablePreviousSummary(ctx.previousSummary)
        ? UPDATE_SUMMARY_PROMPT
        : INITIAL_SUMMARY_PROMPT;
      const input = buildSummarizerInput(ctx.serializedNarrative, ctx.previousSummary, historyPath);

      const { text, ok } = await generateSummaryWithFallback(
        async () => {
          const model = await modelProvider.getModel(SUMMARIZATION_MODEL);
          const result = await generateText({
            model,
            system: prompt,
            prompt: input,
            temperature: 0,
            maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          });
          return result.text;
        },
        async () => {
          const model = await modelProvider.getModel(FALLBACK_SUMMARIZATION_MODEL);
          const result = await generateText({
            model,
            system: prompt,
            prompt: input,
            maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          });
          return result.text;
        },
        (reason, stage) => {
          console.warn(`[compaction-summarizer] ${stage} summary invalid (${reason})`);
        },
      );

      // See stripModelSummaryWrapper: the model imitates the wrapper it is
      // shown on the update path, sometimes inside a ```xml fence.
      const summary = stripModelSummaryWrapper(text);

      if (!ok || !historyPath) {
        return `<compaction-summary>\n${summary}\n</compaction-summary>`;
      }
      const pointer = buildCompactionHistoryPointer(historyDir, historyPath);
      return `<compaction-summary>\n${summary}\n\n${pointer}\n</compaction-summary>`;
    } catch (error: unknown) {
      console.warn(
        '[compaction-summarizer] summarization failed, delegating to middleware fallback:',
        error,
      );
      throw error;
    }
  };
}
