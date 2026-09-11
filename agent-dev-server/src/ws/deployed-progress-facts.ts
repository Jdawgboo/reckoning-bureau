import type { AgentContent } from '../bl/agent/agent-library.ts';

const WEB_SEARCH_TOOL_NAME = 'web_search';
const SEARCH_FACT_INTERVAL = 3;

export type ProgressFactFormatter = (
  messageId: 'voice.webSearchProgress',
  values: { count: number },
) => string;

/**
 * Deployed-runtime progress facts for provider-executed tools. `web_search`
 * runs inside the Anthropic provider — our execute() never fires — so the
 * completed tool part streaming through the run's content is the one truthful
 * place the runtime learns a search happened. Runtime policy by design, like
 * `SurfaceRenderDetector`: shared voice code must never switch on tool names.
 *
 * The fact is a visitor-facing counter, never the query. Queries are
 * model-facing search syntax (`site:` operators, quoted fragments, date
 * strings); a spoken fact carrying one gets pronounced verbatim by the voice
 * model. Counting also gives the fact a cadence: the first search speaks, then
 * every SEARCH_FACT_INTERVAL-th, so a burst of searches cannot flood speech —
 * the same discipline the deep-research producer keeps.
 *
 * One instance covers one run: the attachment builds a content handler per
 * run, so the closure's count never mixes runs.
 */
export function createDeployedProgressFacts(
  format?: ProgressFactFormatter,
): (content: AgentContent) => AgentContent {
  const countedCallIds = new Set<string>();
  let lastReportedCount = 0;
  return (content) => {
    if (content.type !== 'Tool' && content.type !== 'Component') {
      return content;
    }
    if (content.progress || content.streaming?.toolName !== WEB_SEARCH_TOOL_NAME) {
      return content;
    }
    if (content.streaming.state !== 'output-available') {
      return content;
    }
    const callId = content.streaming.toolCallId;
    if (!callId || countedCallIds.has(callId)) {
      return content;
    }
    countedCallIds.add(callId);
    const count = countedCallIds.size;
    if (count !== 1 && count - lastReportedCount < SEARCH_FACT_INTERVAL) {
      return content;
    }
    lastReportedCount = count;
    const text = format
      ? format('voice.webSearchProgress', { count })
      : defaultWebSearchProgress(count);
    return { ...content, progress: { text } };
  };
}

function defaultWebSearchProgress(count: number): string {
  if (count === 1) {
    return 'Checking the web for supporting data.';
  }
  return `Ran ${count} web checks so far.`;
}
