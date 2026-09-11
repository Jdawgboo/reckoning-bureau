/**
 * EventRouter — generic handler registry for the event pipeline.
 *
 * Base class for TriggerRouter, ScheduleRouter, and future event routers.
 * Instance-based (no global singleton) so that multiple agents sharing
 * the same process each get their own isolated set of handlers.
 *
 * Handler names are case-insensitive — both registration and lookup
 * normalize to lowercase.
 *
 * @example
 * ```typescript
 * // Directly:
 * const router = new EventRouter<MyHandler, MyOptions>();
 *
 * // Or via extension:
 * class ScheduleRouter extends EventRouter<ScheduleHandler, ScheduleRegistrationOptions> {}
 * ```
 */

/** A registration entry: handler function + optional options. */
export interface EventRegistration<THandler, TOptions> {
  handler: THandler;
  options?: TOptions;
}

export class EventRouter<
  THandler extends (...args: never[]) => unknown,
  TOptions = Record<string, unknown>,
> {
  #registrations = new Map<string, EventRegistration<THandler, TOptions>>();

  /** Register a handler by name. Case-insensitive. Overwrites any existing handler. */
  register(name: string, handler: THandler, options?: TOptions): void {
    this.#registrations.set(name.toLowerCase(), { handler, options });
  }

  /** Get the handler function by name, or undefined. Case-insensitive. */
  getHandler(name: string): THandler | undefined {
    return this.#registrations.get(name.toLowerCase())?.handler;
  }

  /** Get the full registration (handler + options) by name. Case-insensitive. */
  getRegistration(name: string): EventRegistration<THandler, TOptions> | undefined {
    return this.#registrations.get(name.toLowerCase());
  }

  /** Check if a handler is registered. Case-insensitive. */
  has(name: string): boolean {
    return this.#registrations.has(name.toLowerCase());
  }

  /** Get all registered names (lowercase). */
  getRegisteredNames(): string[] {
    return [...this.#registrations.keys()];
  }
}
