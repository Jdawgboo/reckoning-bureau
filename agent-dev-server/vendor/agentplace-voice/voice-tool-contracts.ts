/** Provider-neutral function tool advertised to a realtime voice model. */
export interface VoiceFunctionToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Existing Agentplace run identity and acceptance state for a delegated voice turn. */
export type StartTurnOutcome =
  | { status: 'started'; runId: string }
  | { status: 'queued'; runId: string }
  | { status: 'busy' };

/** Semantic result returned to the realtime voice model after a function call. */
export type VoiceToolOutcome =
  | { status: 'started' | 'queued'; runId: string }
  | { status: 'busy' }
  | { status: 'completed'; result: string; value?: string }
  | { status: 'needs-input'; reason: string; options?: string[] }
  | { status: 'failed'; reason: string };

/** Typed function result plus whether the provider should answer it immediately. */
export interface VoiceToolResult {
  outcome: VoiceToolOutcome;
  speak: boolean;
  /** Present only for tools that attempted to delegate this spoken turn to an AgentRun. */
  delegation?: StartTurnOutcome | { status: 'failed' };
}

/**
 * The model-facing rendering of a tool outcome, submitted as the function
 * result. Structured status stays the contract between the executor and the
 * orchestrator; this is the one place it becomes prose, so an adapter never
 * invents its own wording for the same outcome.
 */
export function describeVoiceToolOutcome(outcome: VoiceToolOutcome): string {
  switch (outcome.status) {
    case 'started':
      return 'Accepted and running.';
    case 'queued':
      return 'Accepted and queued behind work already running.';
    case 'busy':
      return 'Not accepted — another request is already running.';
    case 'completed':
      return outcome.value ? `${outcome.result}\n${outcome.value}` : outcome.result;
    case 'needs-input':
      return outcome.options && outcome.options.length > 0
        ? `Needs input: ${outcome.reason}\nOptions: ${outcome.options.join(', ')}`
        : `Needs input: ${outcome.reason}`;
    case 'failed':
      return `Failed: ${outcome.reason}`;
  }
}
