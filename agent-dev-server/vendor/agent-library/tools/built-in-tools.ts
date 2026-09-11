/**
 * Canonical registry of built-in tools included in every agent.
 *
 * Both createAgent() and platform-side tool factories should call
 * getBuiltInTools() instead of manually assembling the list — this is
 * the single source of truth for which tools ship with every agent.
 */
import type { ToolModel } from './tool-model.ts';
import type { StateTree } from '../state/state-tree.ts';
import { GetCurrentTimeTool } from './get-current-time-tool.ts';
import { createScheduleTools } from './schedule-tools.ts';

/**
 * Schedule-mutation tool names. A schedule-triggered session must not
 * have access to these (recursion guard: a schedule firing the LLM must
 * not be able to create/update/delete schedules from within that run).
 */
export const SCHEDULE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'createSchedule',
  'updateSchedule',
  'deleteSchedule',
]);

/**
 * Returns the canonical list of built-in tools.
 *
 * @param state — StateTree for tools that need it (schedule tools write
 *   to /data/cron/). When null/undefined, state-dependent
 *   tools are omitted; only state-independent built-ins are returned.
 */
export function getBuiltInTools(state?: StateTree | null): ToolModel[] {
  const tools: ToolModel[] = [new GetCurrentTimeTool()];
  if (state) {
    tools.push(...createScheduleTools(state));
  }
  return tools;
}

/**
 * Strip schedule-mutation tools from a list. Use for schedule-type sessions
 * to prevent recursion (a schedule firing the LLM can still read schedules
 * via listSchedules, but cannot mutate them).
 */
export function filterScheduleSafeTools(tools: ToolModel[]): ToolModel[] {
  return tools.filter((t) => !SCHEDULE_MUTATION_TOOL_NAMES.has(t.getName()));
}
