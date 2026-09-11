import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

type UnifiedFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

export interface ScriptedToolCall {
  toolName: string;
  input: Record<string, unknown>;
  toolCallId?: string;
  /**
   * Emit the tool-input-delta stream as these chunks instead of one delta
   * carrying the whole `JSON.stringify(input)`. Exercises consumers that
   * react to input streaming (e.g. `ToolModel.streamPartialInput`) across
   * several partial-JSON states. The final `tool-call` event still carries
   * the complete, valid `input` regardless of how the chunks concatenate.
   */
  rawInputDeltas?: string[];
}

/** One scripted model response — consumed per doStream call, in order. */
export interface ScriptedStep {
  reasoning?: string;
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Defaults: 'tool-calls' when toolCalls present, otherwise 'stop'. */
  finishReason?: UnifiedFinishReason;
  usage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number };
  /**
   * Finish with every token counter undefined, reproducing a provider that
   * closed the stream without ever sending a usage frame.
   */
  omitUsage?: boolean;
  /** End the stream without a `finish` part, as a truncated provider stream does. */
  omitFinish?: boolean;
  /** Emitted as a stream 'error' part before finishing — exercises retry paths. */
  streamError?: unknown;
}

export interface RecordedModelCall {
  options: LanguageModelV3CallOptions;
  prompt: LanguageModelV3CallOptions['prompt'];
}

function buildUsage(step: ScriptedStep): LanguageModelV3Usage {
  if (step.omitUsage) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }
  const input = step.usage?.inputTokens ?? 100;
  const output = step.usage?.outputTokens ?? 20;
  const cacheRead = step.usage?.cacheRead ?? 0;
  return {
    inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/**
 * Fully-typed LanguageModelV3 fake that speaks the real AI SDK v3 stream
 * protocol, so tests exercise the production stack (ToolLoopAgent runner,
 * middleware composition, processors, tool execution, persistence) with only
 * the network boundary replaced.
 *
 * Each doStream call consumes the next ScriptedStep and records the exact
 * call options it received — the in-test equivalent of a step dump. Assert on
 * `calls[i].prompt` to verify what the model actually saw per step.
 *
 * @example
 * const model = scriptedModel([
 *   { toolCalls: [{ toolName: 'probe', input: { q: 'x' } }] },
 *   { text: 'done' },
 * ]);
 * const agent = new Agent({ model, ... });
 */
export interface ScriptedModelOptions {
  /** Reported provider id — drives provider-gated middleware (e.g. cache strategies). */
  provider?: string;
  modelId?: string;
}

export class ScriptedModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly calls: RecordedModelCall[] = [];
  #steps: ScriptedStep[];
  #cursor = 0;

  constructor(steps: ScriptedStep[], options: ScriptedModelOptions = {}) {
    this.#steps = steps;
    this.provider = options.provider ?? 'scripted';
    this.modelId = options.modelId ?? 'scripted-model';
  }

  get exhausted(): boolean {
    return this.#cursor >= this.#steps.length;
  }

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    throw new Error('ScriptedModel supports doStream only');
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    this.calls.push({ options, prompt: options.prompt });

    const step = this.#steps[this.#cursor];
    if (!step) {
      throw new Error(
        `ScriptedModel exhausted: doStream call #${this.#cursor + 1} but only ${this.#steps.length} step(s) scripted`,
      );
    }
    this.#cursor += 1;

    const parts = this.#buildParts(step, this.#cursor);
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    };
  }

  #buildParts(step: ScriptedStep, callIndex: number): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      {
        type: 'response-metadata',
        id: `scripted-resp-${callIndex}`,
        modelId: this.modelId,
        timestamp: new Date(),
      },
    ];

    if (step.reasoning !== undefined) {
      const id = `r-${callIndex}`;
      parts.push(
        { type: 'reasoning-start', id },
        { type: 'reasoning-delta', id, delta: step.reasoning },
        { type: 'reasoning-end', id },
      );
    }

    if (step.text !== undefined) {
      const id = `t-${callIndex}`;
      parts.push(
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: step.text },
        { type: 'text-end', id },
      );
    }

    for (let i = 0; i < (step.toolCalls?.length ?? 0); i++) {
      const call = step.toolCalls![i];
      const toolCallId = call.toolCallId ?? `call-${callIndex}-${i}`;
      const input = JSON.stringify(call.input);
      const deltas = call.rawInputDeltas ?? [input];
      parts.push({ type: 'tool-input-start', id: toolCallId, toolName: call.toolName });
      for (const delta of deltas) {
        parts.push({ type: 'tool-input-delta', id: toolCallId, delta });
      }
      parts.push(
        { type: 'tool-input-end', id: toolCallId },
        { type: 'tool-call', toolCallId, toolName: call.toolName, input },
      );
    }

    if (step.streamError !== undefined) {
      parts.push({ type: 'error', error: step.streamError });
    }

    if (!step.omitFinish) {
      parts.push({
        type: 'finish',
        usage: buildUsage(step),
        finishReason: {
          unified: step.finishReason ?? (step.toolCalls?.length ? 'tool-calls' : 'stop'),
          raw: undefined,
        },
      });
    }

    return parts;
  }
}

export function scriptedModel(
  steps: ScriptedStep[],
  options?: ScriptedModelOptions,
): ScriptedModel {
  return new ScriptedModel(steps, options);
}
