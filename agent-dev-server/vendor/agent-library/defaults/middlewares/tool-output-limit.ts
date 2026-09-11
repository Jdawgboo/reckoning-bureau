import type { Tool as AiSdkTool } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import type { JSONValue } from '@ai-sdk/provider';
import type { ToolOutput } from '../../types/tool-output.ts';

export const DEFAULT_TOOL_OUTPUT_CHAR_LIMIT = 50_000;

// Marker prefix `[TRUNCATED` is load-bearing — `isStoredReference()` in
// tool-result-compaction.ts relies on it for cache-stability hints.
export function applyToolOutputCharLimit(
  output: ToolOutput,
  limit: number,
  toolName: string,
): ToolOutput {
  if (typeof output !== 'string') return output;
  if (output.length <= limit) return output;
  const omitted = output.length - limit;
  return (
    output.slice(0, limit) +
    `\n\n[TRUNCATED — ${toolName} output: showing ${limit} of ${output.length} characters; ${omitted} omitted from the end.]`
  );
}

function capString(value: string, limit: number, toolName: string): string {
  return applyToolOutputCharLimit(value, limit, toolName) as string;
}

export function capToolResultOutput(
  out: ToolResultOutput,
  limit: number,
  toolName: string,
): ToolResultOutput {
  switch (out.type) {
    case 'text':
      if (out.value.length <= limit) return out;
      return { ...out, value: capString(out.value, limit, toolName) };
    case 'error-text':
      if (out.value.length <= limit) return out;
      return { ...out, value: capString(out.value, limit, toolName) };
    case 'json': {
      // Convert to text on cap — cutting raw JSON in place yields invalid syntax.
      const serialized = JSON.stringify(out.value ?? null);
      if (serialized.length <= limit) return out;
      return {
        type: 'text',
        value: capString(serialized, limit, toolName),
        ...(out.providerOptions ? { providerOptions: out.providerOptions } : {}),
      };
    }
    case 'error-json': {
      const serialized = JSON.stringify(out.value ?? null);
      if (serialized.length <= limit) return out;
      return {
        type: 'error-text',
        value: capString(serialized, limit, toolName),
        ...(out.providerOptions ? { providerOptions: out.providerOptions } : {}),
      };
    }
    case 'content':
      return {
        ...out,
        value: out.value.map((part) =>
          part.type === 'text' ? { ...part, text: capString(part.text, limit, toolName) } : part,
        ),
      };
    default:
      return out;
  }
}

// Native AI-SDK / MCP / provider tools bypass AgentService.executeTool;
// `toModelOutput` is the only chokepoint where their result can be capped.
// Note: AI SDK's createToolModelOutput short-circuits to error-text/error-json
// before calling toModelOutput when errorMode is set, so thrown errors bypass
// this wrapper — consistent with spec §3 (errors are not capped).
export function wrapAiSdkToolWithOutputCap<TIn, TOut>(
  tool: AiSdkTool<TIn, TOut>,
  limit: number,
  toolName: string,
): AiSdkTool<TIn, TOut> {
  const original = (tool as { toModelOutput?: (args: unknown) => unknown | Promise<unknown> })
    .toModelOutput;

  const wrappedToModelOutput = async (args: {
    toolCallId: string;
    input: TIn;
    output: TOut;
  }): Promise<ToolResultOutput> => {
    let raw: ToolResultOutput;
    if (original) {
      raw = (await original(args)) as ToolResultOutput;
    } else {
      raw =
        typeof args.output === 'string'
          ? { type: 'text', value: args.output }
          : { type: 'json', value: (args.output ?? null) as JSONValue };
    }
    return capToolResultOutput(raw, limit, toolName);
  };

  return { ...tool, toModelOutput: wrappedToModelOutput } as AiSdkTool<TIn, TOut>;
}
