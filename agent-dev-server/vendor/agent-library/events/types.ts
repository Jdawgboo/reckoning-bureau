/**
 * Event types for the inbox/outbox pipeline.
 */

import type { StateTree } from '../state/state-tree.ts';

/** Trigger event written to /inbox/triggers/{provider}/{eventId} */
export interface TriggerEvent {
  /** Unique event ID (from Composio log_id or generated) */
  eventId: string;
  /** Trigger slug, e.g. 'github_issue_created' */
  triggerName: string;
  /** Provider slug, e.g. 'github' */
  provider: string;
  /** Trigger-specific payload data */
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Composio trigger instance ID */
  triggerId?: string;
  /** Composio connected account ID */
  connectedAccountId?: string;
}

/** Options for ctx.llm() — invoke the LLM from within a trigger handler. */
export interface TriggerLlmOptions {
  /** The message to send to the LLM. */
  message: string;
}

/** Result from ctx.llm(). */
export interface TriggerLlmResult {
  /** The LLM's text response. */
  text: string;
}

/** Context passed to trigger handlers. */
export interface TriggerContext {
  /** The agent's state tree */
  state: StateTree;
  /** Resolved sessionId from registration options. Undefined for sessionless triggers. */
  sessionId?: string;
  /**
   * Invoke the LLM from within the handler. Uses the agent's configured model and instruction.
   * Provided automatically by the runtime — no setup needed.
   *
   * @example
   * const { text } = await ctx.llm({ message: 'Classify this email as spam or important.' });
   * await ctx.state.set(`/data/emails/${event.eventId}`, { classification: text });
   */
  llm: (options: TriggerLlmOptions) => Promise<TriggerLlmResult>;
}

/** A function that handles a trigger event. Returns void — use ctx.llm() to invoke the LLM. */
export type TriggerHandler = (event: TriggerEvent, ctx: TriggerContext) => void | Promise<void>;

/** Options for trigger registration. */
export interface TriggerRegistrationOptions {
  /**
   * Resolve a sessionId for this trigger event. When provided, related trigger
   * executions share a session for context accumulation across repeated events.
   * When omitted, each execution is independent (sessionless).
   *
   * @example
   * { sessionId: (event) => `trigger/github-issue-${event.payload.issue.number}` }
   */
  sessionId?: (event: TriggerEvent) => string;
}

/** A registered trigger: handler + optional registration options. */
export type TriggerRegistration = import('./event-router.ts').EventRegistration<
  TriggerHandler,
  TriggerRegistrationOptions
>;

/** Function that invokes the LLM, provided by the agent runtime. */
export type TriggerLlmFunction = (
  options: TriggerLlmOptions,
  event: TriggerEvent,
  sessionId?: string,
) => Promise<TriggerLlmResult>;

/** Callback invoked when no handler is registered for a trigger (LLM fallback). */
export type UnhandledTriggerCallback = (
  event: TriggerEvent,
  /** Resolved sessionId from registration options. Undefined for sessionless triggers. */
  sessionId?: string,
) => Promise<void> | void;
