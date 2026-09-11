import type {
  AgentRunner,
  AgentRunnerHandle,
  AgentRunnerRunOptions,
  AgentStreamEvent,
} from '../../runners/agent-runner.ts';

/**
 * Scripted runner step: either a raw runner event, or an instruction to
 * invoke executeTool the way the AI SDK does mid-stream (await it, then
 * auto-emit the matching tool-result / tool-error event).
 */
export type ScriptStep =
  | { kind: 'event'; event: AgentStreamEvent }
  | { kind: 'execute'; toolName: string; toolCallId: string; input: Record<string, unknown> };

export class FakeRunner implements AgentRunner {
  readonly #script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.#script = script;
  }

  async runStream(options: AgentRunnerRunOptions): Promise<AgentRunnerHandle> {
    const script = this.#script;
    let resolveDone: (v: { structuredOutput?: unknown }) => void = () => {};
    const done = new Promise<{ structuredOutput?: unknown }>((r) => {
      resolveDone = r;
    });

    async function* events(): AsyncGenerator<AgentStreamEvent> {
      // `done` must resolve even when the consumer breaks the loop early (on
      // `finish`/`stream-error`/abort), which abandons this generator via
      // `.return()` — so resolve in `finally`, not after the loop body.
      try {
        for (const step of script) {
          if (step.kind === 'event') {
            yield step.event;
            continue;
          }
          try {
            const output = await options.executeTool({
              toolName: step.toolName,
              toolCallId: step.toolCallId,
              input: step.input,
              rawArgs: JSON.stringify(step.input),
            });
            yield {
              type: 'tool-result',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              output,
            };
          } catch (error) {
            yield {
              type: 'tool-error',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              error,
            };
          }
        }
      } finally {
        resolveDone({});
      }
    }

    return { events: events(), done } as AgentRunnerHandle;
  }
}
