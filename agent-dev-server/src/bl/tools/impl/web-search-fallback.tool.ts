/**
 * WebSearchFallbackTool
 *
 * Fallback web search for providers that don't support native web search (e.g. Bedrock Claude).
 * Executes a separate generateText call to Google Vertex with Google Search grounding.
 */
import { generateText } from 'ai';
import {
  ToolModel,
  type ToolExecuteResult,
  type ToolExecuteContext,
} from '../../agent/agent-library.ts';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { VertexProviderMetadata } from '../../agent/interfaces.ts';
import { webSearchParamsSchema, type WebSearchParams } from './web-search-fallback.schema.ts';

/**
 * Follows a Vertex grounding redirect URL to its final destination.
 * Falls back to the original URL on any network error.
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    return response.url;
  } catch {
    return url;
  }
}

const TOOL_NAME = 'web_search';

export interface WebSearchFallbackToolConfig {
  provider: GoogleVertexProvider;
}

export class WebSearchFallbackTool extends ToolModel<WebSearchParams> {
  readonly #provider: GoogleVertexProvider;

  constructor(config: WebSearchFallbackToolConfig) {
    super({
      name: TOOL_NAME,
      toolType: 'function',
      description: `Search the web for ANY real-time or current information. YOU MUST USE THIS TOOL for:
- Current time, date, weather, or any time-sensitive information
- News, events, or anything that changes over time
- Prices, stock quotes, exchange rates
- Sports scores, election results, or live data
- Any question about "today", "now", "current", "latest", or "recent"
- Verifying facts or getting up-to-date information

Returns a synthesized text answer based on web search results, plus source URLs as citations. This is NOT a page fetcher — it does not return the raw HTML or full text of any single page, and passing a URL as \`query\` is interpreted as a search ABOUT that URL, not a request to fetch it.

Use date-range filtering when the user's query is bounded in time (e.g. "papers from the past week", "news since May 1"):
- Call \`getCurrentTime\` first to anchor relative ranges.
- Pass \`start_time\` and \`end_time\` as RFC 3339 timestamps with explicit timezone (preferably UTC, ending in \`Z\`). Both are required together.
- Omit both for open-ended queries; do not invent a date range.`,
      parametersSchema: webSearchParamsSchema,
      isStreaming: true,
    });

    this.#provider = config.provider;
  }

  async execute(input: WebSearchParams, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const { query, start_time, end_time } = input;

    try {
      if (ctx.abortSignal?.aborted) {
        return { output: 'Web search canceled by user.' };
      }

      console.log(`[WebSearchFallbackTool] Executing search for query: "${query}"`);

      const timeRangeFilter =
        start_time && end_time ? { startTime: start_time, endTime: end_time } : undefined;
      const googleSearchTool = this.#provider.tools.googleSearch(
        timeRangeFilter ? { timeRangeFilter } : {},
      );

      const model = this.#provider('gemini-3.1-flash-lite');
      const result = await generateText({
        model,
        tools: { google_search: googleSearchTool },
        toolChoice: 'required',
        maxOutputTokens: 4096,
        temperature: 0,
        abortSignal: ctx.abortSignal,
        prompt: `You are a web search assistant. Search the web for the following query and provide a comprehensive, accurate answer based on the search results.

Query: ${query}

Instructions:
- You MUST use the google_search tool - do not answer from memory
- Provide factual, well-organized responses based ONLY on search results
- Include citations with URLs for your sources
- If the search returns no results, indicate that clearly`,
      });

      const text = result.text || 'No search results found.';
      const vertex = result.providerMetadata?.['vertex'] as VertexProviderMetadata | undefined;
      const chunks = vertex?.groundingMetadata?.groundingChunks ?? [];
      const redirectEntries = chunks
        .map((c) => ({ uri: c.web?.uri, title: c.web?.title }))
        .filter((s): s is { uri: string; title: string | undefined } => typeof s.uri === 'string');

      const resolvedSources = await Promise.all(
        redirectEntries.map(async ({ uri, title }) => {
          const resolved = await resolveRedirectUrl(uri);
          return title ? `[${title}](${resolved})` : resolved;
        }),
      );

      const output =
        resolvedSources.length > 0
          ? `${text}\n\nSources:\n${resolvedSources.map((s) => `- ${s}`).join('\n')}`
          : text;

      return { output };
    } catch (error) {
      console.error('[WebSearchFallbackTool] Error executing web search', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred during web search';
      return {
        output: `Web search failed: ${errorMessage}. Please try again or rephrase your query.`,
      };
    }
  }
}
