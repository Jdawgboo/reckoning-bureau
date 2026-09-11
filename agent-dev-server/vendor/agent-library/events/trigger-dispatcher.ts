/**
 * TriggerDispatcher — routes trigger events to registered handlers.
 *
 * If a handler is registered for the trigger name → executes it with ctx.llm().
 * If no handler → calls the onUnhandled callback (LLM fallback).
 * If neither → logs a warning.
 */

import type { StateTree } from '../state/state-tree.ts';
import type { TriggerRouter } from './trigger-router.ts';
import type {
  TriggerEvent,
  TriggerLlmFunction,
  TriggerRegistration,
  UnhandledTriggerCallback,
} from './types.ts';

export interface TriggerDispatcherOptions {
  router: TriggerRouter;
  state: StateTree;
  /** LLM function provided by the agent runtime, exposed as ctx.llm() to handlers. */
  llm?: TriggerLlmFunction;
  /** Called when no handler is registered for a trigger. Typically sends to LLM. */
  onUnhandled?: UnhandledTriggerCallback;
}

export class TriggerDispatcher {
  #router: TriggerRouter;
  #state: StateTree;
  #llm?: TriggerLlmFunction;
  #onUnhandled?: UnhandledTriggerCallback;

  constructor(options: TriggerDispatcherOptions) {
    this.#router = options.router;
    this.#state = options.state;
    this.#llm = options.llm;
    this.#onUnhandled = options.onUnhandled;
  }

  /** Get registration for a trigger name (used by EventProcessor for activity logging). */
  getRegistration(triggerName: string): TriggerRegistration | undefined {
    return this.#router.getRegistration(triggerName);
  }

  async dispatch(event: TriggerEvent): Promise<void> {
    const registration = this.#router.getRegistration(event.triggerName);

    // Resolve sessionId from registration options (if configured)
    const sessionId = registration?.options?.sessionId?.(event);

    if (registration) {
      const llmBound = this.#llm
        ? (options: { message: string }) => this.#llm!(options, event, sessionId)
        : () => {
            throw new Error(`[TriggerDispatcher] ctx.llm() called but no LLM function configured`);
          };

      await registration.handler(event, {
        state: this.#state,
        sessionId,
        llm: llmBound,
      });
      return;
    }

    if (this.#onUnhandled) {
      console.warn(
        `[TriggerDispatcher] No handler registered for trigger '${event.triggerName}' — falling back to LLM`,
      );
      await this.#onUnhandled(event, sessionId);
      return;
    }

    console.warn(
      `[TriggerDispatcher] No handler for trigger '${event.triggerName}' and no fallback configured`,
    );
  }
}
