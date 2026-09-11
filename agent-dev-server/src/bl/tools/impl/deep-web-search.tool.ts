/**
 * DeepWebSearchTool
 *
 * Web search tool for the deep research sub-agent.
 * Wraps generateText to Gemini with Google Search grounding, and extracts
 * structured source data from the grounding metadata.
 *
 * Unlike WebSearchFallbackTool which only returns text, this tool also returns
 * structured sources in uiProps for the parent DeepResearchToolModel to capture.
 */
import { generateText } from 'ai';
import {
  ToolModel,
  type ToolExecuteResult,
  type ToolExecuteContext,
} from '../../agent/agent-library.ts';
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { VertexProviderMetadata } from '../../agent/interfaces.ts';
import { deepWebSearchParamsSchema, type DeepWebSearchParams } from './deep-web-search.schema.ts';

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

const TOOL_NAME = 'deep_web_search';

export interface DeepWebSearchToolConfig {
  provider: GoogleVertexProvider;
}

interface ExtractedSource {
  url: string;
  domain: string;
  title?: string;
}

export class DeepWebSearchTool extends ToolModel<DeepWebSearchParams> {
  readonly #provider: GoogleVertexProvider;

  constructor(config: DeepWebSearchToolConfig) {
    super({
      name: TOOL_NAME,
      toolType: 'function',
      description:
        'Search the web for information on a specific topic. ' +
        'Returns a synthesized text answer plus source URLs as citations — not raw HTML of any single page. ' +
        'For date-bounded topics, pass start_time and end_time as RFC 3339 timestamps (both required together); ' +
        'use getCurrentTime to compute relative ranges.',
      parametersSchema: deepWebSearchParamsSchema,
      isStreaming: true,
    });

    this.#provider = config.provider;
  }

  async execute(input: DeepWebSearchParams, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const { query, start_time, end_time } = input;

    try {
      if (ctx.abortSignal?.aborted) {
        return { output: 'Search canceled.' };
      }

      console.log(`[DeepWebSearchTool] Searching: "${query}"`);

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
        prompt: `Search the web for the following query and provide a comprehensive answer based on search results. Include citations with URLs.

Query: ${query}

Instructions:
- You MUST use the google_search tool
- Provide factual responses based ONLY on search results
- Include source URLs in your response`,
      });

      const sources = await this.extractSources(result.text, result.providerMetadata);

      console.log(`[DeepWebSearchTool] Found ${sources.length} sources for: "${query}"`);

      return {
        output: result.text || 'No search results found.',
        uiProps: { sources },
      };
    } catch (error) {
      console.error('[DeepWebSearchTool] Error executing search', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during web search';
      return {
        output: `Search failed: ${errorMessage}`,
        uiProps: { sources: [] },
      };
    }
  }

  private async extractSources(
    text: string,
    providerMetadata: Record<string, unknown> | undefined,
  ): Promise<ExtractedSource[]> {
    const seen = new Set<string>();
    const vertex = providerMetadata?.['vertex'] as VertexProviderMetadata | undefined;
    const chunks = vertex?.groundingMetadata?.groundingChunks;

    if (chunks?.length) {
      const resolved = await Promise.all(
        chunks.map(async (chunk) => {
          const uri = chunk.web?.uri;
          if (!uri) return null;
          const realUrl = await resolveRedirectUrl(uri);
          return { realUrl, title: chunk.web?.title };
        }),
      );

      const sources: ExtractedSource[] = [];
      for (const entry of resolved) {
        if (!entry || seen.has(entry.realUrl)) continue;
        seen.add(entry.realUrl);
        try {
          const domain = new URL(entry.realUrl).hostname.replace(/^www\./, '');
          sources.push({ url: entry.realUrl, domain, title: entry.title });
        } catch {
          // skip malformed URLs
        }
      }
      if (sources.length > 0) return sources;
    }

    // Fallback: extract from markdown links when grounding metadata is absent
    const sources: ExtractedSource[] = [];
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    for (const match of text.matchAll(linkRegex)) {
      const title = match[1];
      const url = match[2];
      if (seen.has(url) || /^\d+$/.test(title)) continue;
      seen.add(url);
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        sources.push({ url, domain, title });
      } catch {
        // skip malformed URLs
      }
    }
    return sources;
  }
}
