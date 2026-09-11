/**
 * Provider-native Vertex `urlContext` wrapper. Gemini auto-fetches URLs that
 * appear in the prompt and grounds the response on them (passive — no
 * `tool_use` round-trip). `toolType: 'web_search'` reuses the closed-union
 * escape hatch `XaiXSearchTool` uses; the wire name (`url_context`) is what
 * Vertex actually sees.
 */
import type { GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { Tool as AiSdkTool } from 'ai';
import { z } from 'zod';
import { ToolModel, type ToolCall, type ToolInvocationContext } from '../../agent/agent-library.ts';

const TOOL_NAME = 'url_context';

const urlContextParamsSchema = z.object({}).passthrough();
type UrlContextParams = z.infer<typeof urlContextParamsSchema>;

export interface VertexUrlContextToolConfig {
  /** Vertex provider instance (already configured with project/location/auth). */
  provider: GoogleVertexProvider;
}

export class VertexUrlContextTool extends ToolModel<UrlContextParams> {
  readonly #tool: AiSdkTool<unknown, unknown>;

  constructor(config: VertexUrlContextToolConfig) {
    super({
      name: TOOL_NAME,
      toolType: 'web_search',
      description:
        'Vertex urlContext — auto-fetches URLs that appear in the prompt and grounds the response on the retrieved content.',
      parametersSchema: urlContextParamsSchema,
      isStreaming: false,
    });
    this.#tool = config.provider.tools.urlContext({}) as unknown as AiSdkTool<unknown, unknown>;
  }

  override getAiSdkTool(): AiSdkTool<unknown, unknown> | null {
    return this.#tool;
  }

  async call(
    _toolCall: ToolCall<UrlContextParams>,
    _ui: { append: (content: unknown) => void },
    _ctx: ToolInvocationContext<unknown>,
  ): Promise<unknown> {
    return null;
  }
}
