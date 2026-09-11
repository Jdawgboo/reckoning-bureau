/**
 * FirecrawlScrapeTool — scrape a web page via the platform's Firecrawl service.
 *
 * The agent never holds the Firecrawl key: this tool calls the platform endpoint
 * `/platform-services/firecrawl/scrape` with the agent's access key. The platform
 * verifies the agent purchased Firecrawl, then scrapes with its own credential.
 * On 403 (not purchased) the tool returns a friendly upsell instead of erroring.
 */
import { z } from 'zod';
import {
  ToolModel,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';

const FirecrawlScrapeSchema = z.object({
  url: z
    .string()
    .describe('The full URL of the web page to scrape, e.g. "https://example.com/article".'),
});

type FirecrawlScrapeInput = z.infer<typeof FirecrawlScrapeSchema>;

const TOOL_NAME = 'firecrawl_scrape';
const NOT_PURCHASED_MESSAGE =
  'This agent needs the Firecrawl service to scrape web pages. ' +
  'Ask the builder to add Firecrawl, then try again.';

export type FirecrawlScrapeToolParams = {
  apiBaseUrl: string;
  accessKey: string;
};

export class FirecrawlScrapeTool extends ToolModel<FirecrawlScrapeInput> {
  #endpointUrl: string;
  #accessKey: string;

  constructor(params: FirecrawlScrapeToolParams) {
    super({
      toolType: 'function',
      name: TOOL_NAME,
      description:
        'Scrape a single web page and return its content as clean markdown. ' +
        'Use this to read articles, documentation, or product pages, or to monitor a page. ' +
        'Provide the full URL.',
      parametersSchema: FirecrawlScrapeSchema,
      isStreaming: false,
      isStrict: false,
    });
    this.#endpointUrl = `${params.apiBaseUrl.replace(/\/$/, '')}/platform-services/firecrawl/scrape`;
    this.#accessKey = params.accessKey;
  }

  async execute(input: FirecrawlScrapeInput, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    let response: Response;
    try {
      response = await fetch(this.#endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-key': this.#accessKey,
        },
        body: JSON.stringify({ url: input.url }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return { output: `Failed to reach the scraping service: ${message}` };
    }

    if (response.status === 403) {
      return { output: NOT_PURCHASED_MESSAGE };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { output: `Scrape failed (${response.status}). ${detail.slice(0, 200)}` };
    }

    const json: unknown = await response.json().catch(() => null);
    const markdown = this.#extractMarkdown(json);
    return { output: markdown ?? 'Scrape returned no content.' };
  }

  #extractMarkdown(json: unknown): string | null {
    if (typeof json === 'object' && json !== null && 'markdown' in json) {
      const markdown = (json as Record<string, unknown>).markdown;
      if (typeof markdown === 'string') {
        return markdown;
      }
    }
    return null;
  }
}
