/**
 * ScheduleDispatcher — routes schedule events to registered handlers.
 *
 * If a handler is registered for the handler name → executes it with ctx.llm().
 * If no handler + handler is "__default" → calls the onUnhandled callback (LLM fallback).
 * If neither → logs a warning.
 *
 * Mirrors TriggerDispatcher pattern.
 */

import type { StateTree } from '../state/state-tree.ts';
import { describeSessionIdViolation } from '../sessions/session-id.ts';
import type { ScheduleRouter } from './schedule-router.ts';
import type {
  ScheduleEvent,
  ScheduleLlmFunction,
  ScheduleRegistration,
  UnhandledScheduleCallback,
} from './schedule-types.ts';

export interface ScheduleDispatcherOptions {
  router: ScheduleRouter;
  state: StateTree;
  /** LLM function provided by the agent runtime, exposed as ctx.llm() to handlers. */
  llm?: ScheduleLlmFunction;
  /** Called when no handler is registered for a schedule event. Typically sends to LLM. */
  onUnhandled?: UnhandledScheduleCallback;
}

export class ScheduleDispatcher {
  #router: ScheduleRouter;
  #state: StateTree;
  #llm?: ScheduleLlmFunction;
  #onUnhandled?: UnhandledScheduleCallback;

  constructor(options: ScheduleDispatcherOptions) {
    this.#router = options.router;
    this.#state = options.state;
    this.#llm = options.llm;
    this.#onUnhandled = options.onUnhandled;
  }

  /** Get registration for a handler name (used by EventProcessor for activity logging). */
  getRegistration(handlerName: string): ScheduleRegistration | undefined {
    return this.#router.getRegistration(handlerName);
  }

  async dispatch(event: ScheduleEvent): Promise<void> {
    const registration = this.#router.getRegistration(event.handler);

    // Resolve sessionId: registration override → event's sessionId → ephemeral
    const sessionId = registration?.options?.sessionId?.(event) ?? event.sessionId ?? undefined;
    this.#assertLegalSessionId(sessionId, event);

    if (registration) {
      const llmBound = this.#llm
        ? (options: { message: string }) => this.#llm!(options, event, sessionId)
        : () => {
            throw new Error(`[ScheduleDispatcher] ctx.llm() called but no LLM function configured`);
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
        `[ScheduleDispatcher] No handler registered for schedule '${event.handler}' — falling back to LLM`,
      );
      await this.#onUnhandled(event, sessionId);
      return;
    }

    console.warn(
      `[ScheduleDispatcher] No handler for schedule '${event.handler}' and no fallback configured`,
    );
  }

  /**
   * A registration's `sessionId` resolver is agent-authored, and an event's
   * `sessionId` arrives over the wire — both are untrusted. An id that opens a
   * new path segment is accepted by `state:set` and then filed where no session
   * reader looks, so refuse the run outright rather than half-execute it.
   */
  #assertLegalSessionId(sessionId: string | undefined, event: ScheduleEvent): void {
    if (sessionId === undefined) {
      return;
    }
    const violation = describeSessionIdViolation(sessionId);
    if (violation === null) {
      return;
    }
    throw new Error(
      `[ScheduleDispatcher] Refusing schedule '${event.handler}' (task ${event.taskId}): ${violation}`,
    );
  }
}
