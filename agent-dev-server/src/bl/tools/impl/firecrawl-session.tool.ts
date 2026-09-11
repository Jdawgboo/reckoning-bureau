import { z } from 'zod';
import {
  ToolModel,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';

export type FirecrawlSessionToolParams = {
  apiBaseUrl: string;
  accessKey: string;
};

type PlatformResponse = { status: number; json: unknown } | { networkError: string };

async function callPlatform(
  baseUrl: string,
  accessKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<PlatformResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-access-key': accessKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { networkError: error instanceof Error ? error.message : 'unknown error' };
  }
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
}

function stringField(json: unknown, key: string): string | null {
  if (typeof json === 'object' && json !== null && key in json) {
    const value = (json as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function mapError(status: number, json: unknown): string {
  const code = stringField(json, 'error');
  if (status === 402) {
    return 'Out of credits to open a browser session. Ask the user to top up.';
  }
  if (status === 429) {
    return code === 'rate_limited'
      ? 'Opening sessions too quickly — wait a moment and try again.'
      : 'Too many active browser sessions right now — close one or try again shortly.';
  }
  if (status === 410) {
    return 'The session expired. Open a new session (action="open") and log in again.';
  }
  if (status === 403) {
    return code === 'forbidden'
      ? 'That session belongs to a different user.'
      : 'Firecrawl is not enabled for this agent. Ask the builder to add it, then try again.';
  }
  return `Request failed (${status}).`;
}

const FirecrawlSessionSchema = z.object({
  action: z
    .enum(['open', 'interact', 'scrape', 'close'])
    .describe(
      'open: start a session at a login/entry url. interact: run Playwright code (e.g. log in). ' +
        'scrape: read a page inside the session. close: end the session.',
    ),
  sessionId: z
    .string()
    .optional()
    .describe('Required for interact/scrape/close — the id returned by an open.'),
  url: z
    .string()
    .optional()
    .describe('For open: the login/entry url. For scrape: the page to read.'),
  code: z
    .string()
    .optional()
    .describe(
      'For interact: Playwright Node code. Top-level await is allowed; the LAST expression is ' +
        'returned — do NOT use a top-level `return`.',
    ),
  profile: z.string().optional().describe('For open: optional named profile.'),
  locationCountry: z
    .string()
    .optional()
    .describe('For open: optional 2-letter proxy country, e.g. "PL".'),
  timeout: z.number().optional().describe('For interact: code timeout in seconds (default 30).'),
});
type FirecrawlSessionInput = z.infer<typeof FirecrawlSessionSchema>;

/**
 * One agent tool for the Firecrawl session lifecycle (open → interact → scrape → close),
 * calling the platform's `/platform-services/firecrawl/session*` endpoints (key hidden).
 * A 410 means the session expired — open a new one.
 */
export class FirecrawlSessionTool extends ToolModel<FirecrawlSessionInput> {
  #baseUrl: string;
  #accessKey: string;

  constructor(params: FirecrawlSessionToolParams) {
    super({
      toolType: 'function',
      name: 'firecrawl_session',
      description:
        'Log into and scrape websites behind a login or Cloudflare via a live browser session. ' +
        'Lifecycle: action="open" {url[,profile,locationCountry]} → sessionId; action="interact" ' +
        '{sessionId,code} → run login code (returns interactiveLiveViewUrl if a human must finish); ' +
        'action="scrape" {sessionId,url} → read an authenticated page; action="close" {sessionId}. ' +
        'Reuse one session for many pages.',
      parametersSchema: FirecrawlSessionSchema,
      isStreaming: false,
      isStrict: false,
    });
    this.#baseUrl = `${params.apiBaseUrl.replace(/\/$/, '')}/platform-services/firecrawl`;
    this.#accessKey = params.accessKey;
  }

  async execute(
    input: FirecrawlSessionInput,
    _ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    switch (input.action) {
      case 'open':
        return this.#open(input);
      case 'interact':
        return this.#interact(input);
      case 'scrape':
        return this.#scrapeInSession(input);
      case 'close':
        return this.#close(input);
    }
  }

  async #open(input: FirecrawlSessionInput): Promise<ToolExecuteResult> {
    if (!input.url) {
      return { output: 'open requires "url".' };
    }
    const res = await callPlatform(this.#baseUrl, this.#accessKey, 'POST', '/session', {
      url: input.url,
      profile: input.profile,
      locationCountry: input.locationCountry,
    });
    if ('networkError' in res) {
      return { output: `Failed to reach the platform: ${res.networkError}` };
    }
    if (res.status !== 200) {
      return { output: mapError(res.status, res.json) };
    }
    const sessionId = stringField(res.json, 'sessionId');
    if (!sessionId) {
      return { output: 'The session opened but no sessionId was returned.' };
    }
    return {
      output: `Opened session ${sessionId}. Use action="interact" to log in, action="scrape" to read pages, action="close" when done.`,
    };
  }

  async #interact(input: FirecrawlSessionInput): Promise<ToolExecuteResult> {
    if (!input.sessionId || !input.code) {
      return { output: 'interact requires "sessionId" and "code".' };
    }
    const res = await callPlatform(
      this.#baseUrl,
      this.#accessKey,
      'POST',
      `/session/${input.sessionId}/interact`,
      { code: input.code, timeout: input.timeout },
    );
    if ('networkError' in res) {
      return { output: `Failed to reach the platform: ${res.networkError}` };
    }
    if (res.status !== 200) {
      return { output: mapError(res.status, res.json) };
    }
    const result = stringField(res.json, 'result') ?? '';
    const liveView = stringField(res.json, 'interactiveLiveViewUrl');
    const lines = [`Interact result: ${result || '(no output)'}`];
    if (liveView) {
      lines.push(`Live-view URL (show to the user for manual login): ${liveView}`);
    }
    return { output: lines.join('\n') };
  }

  async #scrapeInSession(input: FirecrawlSessionInput): Promise<ToolExecuteResult> {
    if (!input.sessionId || !input.url) {
      return { output: 'scrape requires "sessionId" and "url".' };
    }
    const res = await callPlatform(
      this.#baseUrl,
      this.#accessKey,
      'POST',
      `/session/${input.sessionId}/scrape`,
      { url: input.url },
    );
    if ('networkError' in res) {
      return { output: `Failed to reach the platform: ${res.networkError}` };
    }
    if (res.status !== 200) {
      return { output: mapError(res.status, res.json) };
    }
    return { output: stringField(res.json, 'content') ?? 'The page returned no content.' };
  }

  async #close(input: FirecrawlSessionInput): Promise<ToolExecuteResult> {
    if (!input.sessionId) {
      return { output: 'close requires "sessionId".' };
    }
    const res = await callPlatform(
      this.#baseUrl,
      this.#accessKey,
      'DELETE',
      `/session/${input.sessionId}`,
    );
    if ('networkError' in res) {
      return { output: `Failed to reach the platform: ${res.networkError}` };
    }
    if (res.status !== 200) {
      return { output: mapError(res.status, res.json) };
    }
    return { output: 'Session closed.' };
  }
}
