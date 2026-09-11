import { z } from 'zod';
import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Built-in tool that returns the current UTC datetime and weekday.
 *
 * Agents must call this before creating schedules with relative times
 * ("remind me in 2 hours", "tomorrow at 3pm") — the system prompt does
 * not inject the current time to avoid stale values in long conversations.
 * `dayOfWeek` is the UTC weekday name for `currentTime`, so the model never
 * has to derive the day of week itself (it does so unreliably).
 */
export class GetCurrentTimeTool extends ToolModel<Record<string, never>> {
  constructor() {
    super({
      name: 'getCurrentTime',
      description:
        'Returns the current date, time (UTC) and day of the week. Call this before creating scheduled tasks with relative times (e.g., "in 2 hours", "tomorrow at 3pm"), and whenever you need to state or reason about the weekday of a date — use the returned dayOfWeek, never compute it yourself.',
      parametersSchema: z.object({}),
      toolType: 'function',
    });
  }

  async execute(
    _input: Record<string, never>,
    _ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    const now = new Date();
    return {
      output: JSON.stringify({
        currentTime: now.toISOString(),
        dayOfWeek: WEEKDAYS[now.getUTCDay()],
      }),
    };
  }
}
