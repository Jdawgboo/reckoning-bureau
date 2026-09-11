import {
  ToolLoopAgent,
  Output,
  hasToolCall,
  stepCountIs,
  type StopCondition,
  type SystemModelMessage,
  type LanguageModelUsage,
} from 'ai';
import type {
  AgentRunner,
  AgentRunnerHandle,
  AgentRunnerRunOptions,
  AgentStreamEvent,
  FinishReason,
} from './agent-runner.ts';
import { generateShortId } from '../types/id.ts';
import { logAgentError } from '../util/log-agent-error.ts';
import { buildToolSet } from './tool-loop-agent/tool-loop-agent.tools.ts';

export class ToolLoopAgentRunner implements AgentRunner {
  async runStream(options: AgentRunnerRunOptions): Promise<AgentRunnerHandle> {
    const tools = buildToolSet(options);
    const stopConditions: StopCondition<any>[] = [];
    if (options.stopAtToolNames && options.stopAtToolNames.length > 0) {
      stopConditions.push(...options.stopAtToolNames.map((t) => hasToolCall(t)));
    }
    stopConditions.push(stepCountIs(options.maxSteps));
    if (options.stopWhen) {
      const extras = Array.isArray(options.stopWhen) ? options.stopWhen : [options.stopWhen];
      stopConditions.push(...(extras as StopCondition<any>[]));
    }
    stopConditions.push(() => options.appState.hasPendingToolCalls());
    const stopWhen = stopConditions.length === 1 ? stopConditions[0] : stopConditions;

    const createOutput = (schema: any) => Output.object({ schema });
    const output = options.structuredOutputSchema
      ? createOutput(options.structuredOutputSchema)
      : undefined;

    const instructionsIdx = options.messages.findIndex((m) => m.role === 'system');

    const hasSystemInstructions = instructionsIdx !== -1;
    const systemInstructions = hasSystemInstructions
      ? (options.messages[instructionsIdx] as SystemModelMessage)
      : undefined;

    const messagesForStream = hasSystemInstructions
      ? options.messages.filter((m) => m.role !== 'system')
      : options.messages;

    let resolveOnFinish: () => void;
    const onFinishPromise = new Promise<void>((resolve) => {
      resolveOnFinish = resolve;
    });
    const agent = new ToolLoopAgent({
      model: options.model,
      ...(systemInstructions ? { instructions: systemInstructions } : {}),
      tools,
      stopWhen,
      output,
      onStepFinish: ({ response }) => {
        const messages = response.messages;
        if (messages.length > 0) {
          options.onStepMessages?.(messages);
        }
      },
      onFinish: ({ usage }) => {
        if (usage) {
          options.appState.setLastUsage?.(usage);
        }
        resolveOnFinish();
      },
      prepareCall: ({ ...settings }) => ({
        ...settings,
        temperature: options.modelSettings?.temperature,
        maxOutputTokens: options.modelSettings?.maxOutputTokens,
        providerOptions: options.modelSettings?.providerOptions,
      }),
      prepareStep: options.prepareStep
        ? async ({ messages, stepNumber, steps }) =>
            options.prepareStep!({ stepNumber, messages, steps })
        : undefined,
    });

    options.appState?.setRunnerState(agent as unknown);

    const res = await agent.stream({
      messages: messagesForStream,
      abortSignal: options.abortSignal,
    });

    let firstStreamError: unknown | null = null;

    let resolveDone!: (value: { structuredOutput?: unknown }) => void;
    const donePromise = new Promise<{ structuredOutput?: unknown }>((resolve) => {
      resolveDone = resolve;
    });

    let stepCount = 0;
    let lastFinishReason: FinishReason | undefined;
    let stepInFlight = false;
    let stepPrefix = generateShortId(8);
    let partSeq = 0;
    const makeMessageId = (partId: string) => `${stepPrefix}:${partId}`;
    let didCallOnEnd = false;

    // State for merging consecutive text/reasoning content parts within a step.
    // The AI SDK may split a single logical text response into multiple content
    // parts with different IDs. We merge them only when text-end is immediately
    // followed by text-start (same for reasoning).
    let currentTextMessageId: string | null = null;
    let currentReasoningMessageId: string | null = null;
    let lastBoundaryType: string | null = null;

    // Guard with .catch() so a rejected `res.text` / `res.output` never
    // becomes an unhandled rejection when `onFinish` doesn't fire.
    const outputPromise = Promise.resolve(res)
      .then(async (finalResult: unknown) => {
        if (options.structuredOutputSchema && finalResult && 'output' in (finalResult as object)) {
          const structuredOutput = await Promise.resolve(
            (finalResult as { output?: unknown }).output,
          );
          return { structuredOutput, textOutput: undefined };
        }

        if (finalResult && 'text' in (finalResult as object)) {
          const textOutput = await Promise.resolve(
            (finalResult as { text?: PromiseLike<string> }).text,
          );
          return { structuredOutput: undefined, textOutput };
        }

        return { structuredOutput: undefined, textOutput: undefined };
      })
      .catch(() => {
        // Stream error already captured via firstStreamError; swallow here
        // to prevent unhandled rejection when onFinish never fires.
        return { structuredOutput: undefined, textOutput: undefined };
      });

    const events = (async function* (): AsyncIterable<AgentStreamEvent> {
      try {
        const streamParts: AsyncIterable<unknown> =
          'fullStream' in (res as object) &&
          (res as { fullStream?: AsyncIterable<unknown> }).fullStream
            ? (res as { fullStream: AsyncIterable<unknown> }).fullStream
            : (res as { textStream: AsyncIterable<string> }).textStream;

        for await (const part of streamParts) {
          if (typeof part === 'string') {
            yield { type: 'text-delta', messageId: makeMessageId('text'), textDelta: part };
            continue;
          }

          const typedPart = part as { type: string; [key: string]: unknown };

          if (typedPart.type === 'start-step') {
            stepCount += 1;
            stepInFlight = true;
            stepPrefix = generateShortId(8);
            partSeq = 0;
            currentTextMessageId = null;
            currentReasoningMessageId = null;
            lastBoundaryType = null;
            yield { type: 'model-step-start', stepIndex: stepCount };
            continue;
          }

          if (typedPart.type === 'finish-step') {
            const usage = typedPart.usage as LanguageModelUsage | undefined;
            const finishReason = typedPart.finishReason as FinishReason | undefined;
            // Provider-specific metadata (Anthropic `server_tool_use`,
            // Vertex `groundingMetadata`, Bedrock-Nova grounding counts,
            // reasoning token splits, etc.) lives here — AI SDK normalises
            // `usage` to a token-only shape and routes everything else to
            // `providerMetadata`. Billing capture needs both.
            const providerMetadata = typedPart.providerMetadata as
              | Record<string, Record<string, unknown>>
              | undefined;
            lastFinishReason = finishReason;
            stepInFlight = false;
            if (usage) {
              options.appState.setLastUsage?.(usage);
            }
            yield {
              type: 'model-step-end',
              stepIndex: stepCount,
              usage,
              finishReason,
              ...(providerMetadata && { providerMetadata }),
            };
            continue;
          }

          if (typedPart.type === 'error') {
            firstStreamError = typedPart.error;
            // Stream-error mid-step — emit a synthetic `model-step-end`
            // first so capture sites see the step ended. Some provider
            // clients attach a partial `usage` to the error event itself
            // (Anthropic does for tool-using turns that died mid-stream);
            // we read it best-effort. Without this synthetic event the
            // in-flight step's prompt-token charge is silently dropped —
            // user incurred the cost, no row written.
            if (stepInFlight) {
              const partialUsage = (typedPart.usage as LanguageModelUsage | undefined) ?? undefined;
              const partialMetadata = typedPart.providerMetadata as
                | Record<string, Record<string, unknown>>
                | undefined;
              stepInFlight = false;
              yield {
                type: 'model-step-end',
                stepIndex: stepCount,
                usage: partialUsage,
                finishReason: 'error',
                ...(partialMetadata && { providerMetadata: partialMetadata }),
              };
            }
            yield { type: 'stream-error', error: typedPart.error };
            yield { type: 'finish', finishReason: lastFinishReason };
            return;
          }

          if (typedPart.type === 'text-start') {
            if (lastBoundaryType === 'text-end' && currentTextMessageId) {
              // Consecutive text parts (text-end → text-start) — reuse messageId to merge
            } else {
              currentTextMessageId = `${stepPrefix}:t${partSeq++}`;
            }
            lastBoundaryType = 'text-start';
            continue;
          }

          if (typedPart.type === 'text-end') {
            lastBoundaryType = 'text-end';
            continue;
          }

          if (typedPart.type === 'reasoning-start') {
            if (lastBoundaryType === 'reasoning-end' && currentReasoningMessageId) {
              // Consecutive reasoning parts (reasoning-end → reasoning-start) — reuse messageId
            } else {
              currentReasoningMessageId = `${stepPrefix}:r${partSeq++}`;
            }
            lastBoundaryType = 'reasoning-start';
            continue;
          }

          if (typedPart.type === 'reasoning-end') {
            lastBoundaryType = 'reasoning-end';
            continue;
          }

          if (typedPart.type === 'text-delta') {
            yield {
              type: 'text-delta',
              messageId: currentTextMessageId ?? makeMessageId(typedPart.id as string),
              textDelta: String(typedPart.text ?? ''),
            };
            continue;
          }

          if (typedPart.type === 'reasoning-delta') {
            yield {
              type: 'reasoning-delta',
              messageId: currentReasoningMessageId ?? makeMessageId(typedPart.id as string),
              textDelta: String(typedPart.text ?? ''),
            };
            continue;
          }

          if (typedPart.type === 'tool-input-start') {
            lastBoundaryType = null;
            yield {
              type: 'tool-input-start',
              toolCallId: String(typedPart.id ?? ''),
              toolName: String(typedPart.toolName ?? ''),
            };
            continue;
          }

          if (typedPart.type === 'tool-input-delta') {
            yield {
              type: 'tool-input-delta',
              toolCallId: String(typedPart.id ?? ''),
              delta: String(typedPart.delta ?? ''),
            };
            continue;
          }

          if (typedPart.type === 'tool-input-end') {
            yield { type: 'tool-input-end', toolCallId: String(typedPart.id ?? '') };
            continue;
          }

          if (typedPart.type === 'tool-call') {
            yield {
              type: 'tool-call',
              toolCallId: String(typedPart.toolCallId ?? ''),
              toolName: String(typedPart.toolName ?? ''),
              input: typedPart.input,
            };
            continue;
          }

          if (typedPart.type === 'tool-result') {
            yield {
              type: 'tool-result',
              toolCallId: String(typedPart.toolCallId ?? ''),
              toolName: String(typedPart.toolName ?? ''),
              output: typedPart.output,
            };
            continue;
          }

          if (typedPart.type === 'tool-error') {
            yield {
              type: 'tool-error',
              toolCallId: String(typedPart.toolCallId ?? ''),
              toolName: String(typedPart.toolName ?? ''),
              error: typedPart.error,
            };
            continue;
          }

          if (typedPart.type === 'source') {
            // AI SDK normalises provider grounding (Vertex `googleSearch`,
            // OpenAI URL annotations, etc.) onto `source` parts. Forward
            // them so downstream UI can render citations.
            const sourceType = typedPart.sourceType === 'document' ? 'document' : 'url';
            yield {
              type: 'source',
              sourceId: String(typedPart.id ?? ''),
              sourceType,
              url: typeof typedPart.url === 'string' ? typedPart.url : undefined,
              title: typeof typedPart.title === 'string' ? typedPart.title : undefined,
            };
            continue;
          }

          if (typedPart.type === 'finish') {
            if (!didCallOnEnd) {
              didCallOnEnd = true;
              options.onEnd?.();
            }
            const stopReason: 'max-steps' | undefined =
              (!options.stopAtToolNames || options.stopAtToolNames.length === 0) &&
              stepCount >= options.maxSteps
                ? 'max-steps'
                : undefined;
            yield { type: 'finish', stopReason, finishReason: lastFinishReason };
          }
        }
      } catch (error) {
        logAgentError('[ToolLoopAgentRunner] Stream error', error);
        firstStreamError = firstStreamError ?? error;
        // Iterator-thrown error mid-step (e.g. `TypeError: terminated` from a
        // dropped socket). Mirror the path-A shape at line 197-223: emit a
        // synthetic `model-step-end` so capture sites see the step ended.
        // Without this, the in-flight step's prompt-token charge is silently
        // dropped — user incurred the cost, no row written. `usage` is
        // undefined because the SDK never delivered a finish-step part.
        if (stepInFlight) {
          stepInFlight = false;
          yield {
            type: 'model-step-end',
            stepIndex: stepCount,
            usage: undefined,
            finishReason: 'error',
          };
        }
        yield { type: 'stream-error', error };
        yield { type: 'finish', finishReason: lastFinishReason };
      } finally {
        if (!didCallOnEnd) {
          didCallOnEnd = true;
          options.onEnd?.();
        }
        // Fallback: settle donePromise so `done` never hangs.
        // stopReason/finishReason now flow through the finish event,
        // so this only needs to carry structuredOutput (if available).
        resolveDone({ structuredOutput: undefined });
      }
    })();

    void onFinishPromise
      .then(() => outputPromise)
      .then(({ structuredOutput }) => {
        resolveDone({ structuredOutput });
      })
      .catch(() => {
        // If onFinish chain fails, resolve with empty — error already in stream-error event.
        resolveDone({ structuredOutput: undefined });
      });

    return { events, done: donePromise };
  }
}
