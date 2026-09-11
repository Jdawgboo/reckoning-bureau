/**
 * ScheduleRouter — registry for scheduled-task handler functions.
 *
 * Extends the generic EventRouter with schedule-specific type aliases.
 *
 * Handler names are case-insensitive — both registration and lookup
 * normalize to lowercase.
 *
 * @example
 * ```typescript
 * const router = new ScheduleRouter();
 * router.register('weather_check', async (event, ctx) => {
 *   const { city } = event.params;
 *   const { text } = await ctx.llm({ message: `Check weather in ${city}` });
 *   await ctx.state.set(`/data/weather/${city}`, { summary: text });
 * });
 * ```
 */

import { EventRouter } from './event-router.ts';
import type { ScheduleHandler, ScheduleRegistrationOptions } from './schedule-types.ts';

export class ScheduleRouter extends EventRouter<ScheduleHandler, ScheduleRegistrationOptions> {}
