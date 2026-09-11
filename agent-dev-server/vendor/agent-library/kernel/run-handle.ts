import type { CancelableStream } from '../types/cancelable-stream.ts';
import type { AgentContent } from '../types/content.ts';
import type { AgentRunOutcome } from '../core/agent.service.ts';
import type { AgentStreamEvent } from '../runners/agent-runner.ts';
import type { AguiEvent } from '../agui/events.ts';

export type AgentRunHandle<TResult = unknown> = {
  /** UI content stream (aggregated AgentContent for React rendering) */
  stream: CancelableStream<AgentContent>;
  /** Raw event stream (for transport/WebSocket) */
  events: AsyncIterable<AgentStreamEvent>;
  /** Native AG-UI event stream (for the AG-UI wire) */
  agui: AsyncIterable<AguiEvent>;
  /** Promise that resolves when the run completes */
  done: Promise<AgentRunOutcome>;
  /** Structured output result (if outputSchema was provided) */
  result?: Promise<TResult>;
};
