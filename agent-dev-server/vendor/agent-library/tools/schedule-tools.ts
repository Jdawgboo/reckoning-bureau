/**
 * Schedule tools — 4 tools for creating, updating, deleting, and listing schedules.
 *
 * Factory: `createScheduleTools(state)` returns all 4 tools, ready for ToolRegistry.
 * Tools write to `/data/cron/{taskId}` in the state tree.
 * StateService hook on Platform Server picks up writes and indexes them for the scheduler.
 */

import { z } from 'zod';
import { ToolModel, type ToolExecuteResult, type ToolExecuteContext } from './tool-model.ts';
import type { StateTree } from '../state/state-tree.ts';
import type {
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
} from '../events/schedule-types.ts';
import {
  isValidHandlerName,
  isLikelyValidCronExpression,
  isValidIanaTimeZone,
  DEFAULT_HANDLER,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_CRON_EXPR_LENGTH,
  MAX_TZ_NAME_LENGTH,
  MAX_PARAMS_JSON_BYTES,
  MAX_AGENT_SCHEDULES,
  SCHEDULE_STATE_PREFIX,
  SCHEDULE_STATE_PATH_RE,
} from '../events/schedule-types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateTaskId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function schedulePath(taskId: string): string {
  return `${SCHEDULE_STATE_PREFIX}${taskId}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const paramsSchema = z
  .record(z.unknown())
  .refine((p) => JSON.stringify(p).length <= MAX_PARAMS_JSON_BYTES, {
    message: `params exceeds ${MAX_PARAMS_JSON_BYTES} bytes when serialized`,
  });

const cronKindSchema = z.object({
  kind: z.literal('cron'),
  expr: z.string().min(1).max(MAX_CRON_EXPR_LENGTH),
  tz: z.string().max(MAX_TZ_NAME_LENGTH).optional(),
});

const everyKindSchema = z.object({
  kind: z.literal('every'),
  everyMs: z.number().int().min(60_000, 'Minimum interval is 60000ms (1 minute)'),
});

const atKindSchema = z.object({
  kind: z.literal('at'),
  at: z.string().min(1).max(64),
});

const scheduleKindSchema = z.discriminatedUnion('kind', [
  cronKindSchema,
  everyKindSchema,
  atKindSchema,
]);

const createSchema = z.object({
  name: z.string().min(1).max(MAX_SCHEDULE_NAME_LENGTH),
  schedule: scheduleKindSchema,
  enabled: z.boolean().optional(),
  handler: z.string().optional(),
  params: paramsSchema.optional(),
  sessionId: z.string().optional(),
  useCurrentSession: z
    .boolean()
    .optional()
    .describe(
      "Default true. true — continues the current chat (reminders, follow-ups). false — runs in a fresh per-fire session; use when the task can be completed without the current chat context and you don't want to clutter the current chat history with the run output.",
    ),
  replyTo: z
    .array(
      z.object({
        channelType: z.string(),
        channelId: z.string(),
        threadId: z.string().optional(),
      }),
    )
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  expiresAt: z.string().optional(),
  sessionCleanup: z
    .enum(['delete', 'keep'])
    .optional()
    .describe(
      'Applies only with `useCurrentSession: false`. `keep` (default) preserves the per-fire session, `delete` wipes it after the run finishes.',
    ),
});

const updateSchema = z.object({
  taskId: z.string().min(1),
  name: z.string().min(1).max(MAX_SCHEDULE_NAME_LENGTH).optional(),
  params: paramsSchema.optional(),
  enabled: z.boolean().optional(),
  schedule: scheduleKindSchema.optional(),
  replyTo: z
    .array(
      z.object({
        channelType: z.string(),
        channelId: z.string(),
        threadId: z.string().optional(),
      }),
    )
    .optional(),
  sessionId: z.string().optional(),
});

const deleteSchema = z.object({
  taskId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate schedule shape for kinds the Zod discriminated union can't
 * express fully: future-only `at` times, cron expression structure, and
 * IANA timezone. Returns an error message or null.
 */
function validateScheduleKind(schedule: CreateScheduleInput['schedule']): string | null {
  if (schedule.kind === 'at') {
    const fireTime = new Date(schedule.at).getTime();
    if (Number.isNaN(fireTime)) {
      return `Invalid "at" datetime: "${schedule.at}". Must be a valid ISO 8601 UTC datetime.`;
    }
    if (fireTime <= Date.now()) {
      return `"at" datetime must be in the future. Got: "${schedule.at}".`;
    }
    return null;
  }
  if (schedule.kind === 'cron') {
    if (!isLikelyValidCronExpression(schedule.expr)) {
      return `Invalid cron expression "${schedule.expr}". Expected 5 whitespace-separated fields with in-range values, e.g. "0 8 * * *".`;
    }
    if (schedule.tz !== undefined && !isValidIanaTimeZone(schedule.tz)) {
      return `Invalid IANA timezone "${schedule.tz}". Use identifiers like "Europe/Berlin" or "America/New_York".`;
    }
  }
  return null;
}

function validateCreate(input: CreateScheduleInput): string | null {
  const handler = input.handler ?? DEFAULT_HANDLER;
  if (!isValidHandlerName(handler)) {
    return `Invalid handler name "${handler}". Must match /^[a-zA-Z0-9_-]{1,64}$/ or be "${DEFAULT_HANDLER}".`;
  }
  return validateScheduleKind(input.schedule);
}

function validateUpdate(input: UpdateScheduleInput): string | null {
  if (input.schedule) {
    return validateScheduleKind(input.schedule);
  }
  return null;
}

function computeDefaultExpiry(input: CreateScheduleInput): string {
  if (input.schedule.kind === 'at') {
    const fireTime = new Date(input.schedule.at).getTime();
    return new Date(fireTime + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Tool: createSchedule
// ---------------------------------------------------------------------------

class CreateScheduleTool extends ToolModel<CreateScheduleInput> {
  #state: StateTree;

  constructor(state: StateTree) {
    super({
      name: 'createSchedule',
      description:
        'Create a scheduled task. Use { kind: "at", at: "ISO UTC datetime" } for one-time reminders, { kind: "every", everyMs: milliseconds } for recurring intervals (min 60000), or { kind: "cron", expr: "cron expression", tz: "timezone" } for cron-expression schedules.',
      parametersSchema: createSchema,
      toolType: 'function',
    });
    this.#state = state;
  }

  async execute(input: CreateScheduleInput, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const error = validateCreate(input);
    if (error) {
      return { output: JSON.stringify({ error }) };
    }

    // Runaway-guard: stop the agent from spawning an unbounded number of
    // schedules. Platform-server tools layer their own env-specific caps on
    // top (preview vs published), but this is the defense-in-depth limit
    // that applies to any agent tool call.
    const existing = (await this.#state.list(SCHEDULE_STATE_PREFIX)).filter((p) =>
      SCHEDULE_STATE_PATH_RE.test(p),
    );
    if (existing.length >= MAX_AGENT_SCHEDULES) {
      return {
        output: JSON.stringify({
          error: `Schedule limit reached (${MAX_AGENT_SCHEDULES}). Delete an existing schedule before creating a new one.`,
        }),
      };
    }

    const taskId = generateTaskId();
    const now = nowISO();
    const handler = input.handler ?? DEFAULT_HANDLER;
    // Session resolution: explicit sessionId > useCurrentSession (default true) > undefined
    const useCurrentSession = input.useCurrentSession ?? true;
    const sessionId = input.sessionId ?? (useCurrentSession ? ctx.sessionId : undefined);

    const schedule: Schedule = {
      taskId,
      name: input.name,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      handler,
      params: input.params ?? {},
      origin: 'agent',
      sessionId,
      replyTo: input.replyTo,
      maxTurns: input.maxTurns,
      timeoutSeconds: input.timeoutSeconds,
      maxRetries: input.maxRetries,
      expiresAt: input.expiresAt ?? computeDefaultExpiry(input),
      sessionCleanup: input.sessionCleanup,
      // Platform-managed fields — set defaults, StateService hook augments on CRON#active
      configId: '',
      nextRunAt: '',
      consecutiveErrors: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.#state.set(schedulePath(taskId), schedule);

    return {
      output: JSON.stringify({
        taskId,
        name: schedule.name,
        schedule: schedule.schedule,
        handler,
        enabled: schedule.enabled,
        expiresAt: schedule.expiresAt,
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: updateSchedule
// ---------------------------------------------------------------------------

class UpdateScheduleTool extends ToolModel<UpdateScheduleInput> {
  #state: StateTree;

  constructor(state: StateTree) {
    super({
      name: 'updateSchedule',
      description:
        'Update an existing schedule by taskId. Only mutable fields can be changed: name, params, enabled, schedule, replyTo, sessionId. Handler cannot be changed — delete and recreate instead.',
      parametersSchema: updateSchema,
      toolType: 'function',
    });
    this.#state = state;
  }

  async execute(input: UpdateScheduleInput, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const error = validateUpdate(input);
    if (error) {
      return { output: JSON.stringify({ error }) };
    }

    const existing = await this.#state.get<Schedule>(schedulePath(input.taskId));
    if (!existing) {
      return { output: JSON.stringify({ error: `Schedule not found: "${input.taskId}"` }) };
    }

    const updated: Schedule = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.params !== undefined && { params: input.params }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.schedule !== undefined && { schedule: input.schedule }),
      ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      updatedAt: nowISO(),
    };

    await this.#state.set(schedulePath(input.taskId), updated);

    return {
      output: JSON.stringify({
        taskId: updated.taskId,
        name: updated.name,
        schedule: updated.schedule,
        handler: updated.handler,
        enabled: updated.enabled,
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: deleteSchedule
// ---------------------------------------------------------------------------

class DeleteScheduleTool extends ToolModel<{ taskId: string }> {
  #state: StateTree;

  constructor(state: StateTree) {
    super({
      name: 'deleteSchedule',
      description: 'Delete a schedule by taskId.',
      parametersSchema: deleteSchema,
      toolType: 'function',
    });
    this.#state = state;
  }

  async execute(input: { taskId: string }, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const existing = await this.#state.get<Schedule>(schedulePath(input.taskId));
    if (!existing) {
      return { output: JSON.stringify({ error: `Schedule not found: "${input.taskId}"` }) };
    }

    await this.#state.delete(schedulePath(input.taskId));

    return {
      output: JSON.stringify({ deleted: true, taskId: input.taskId, name: existing.name }),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: listSchedules
// ---------------------------------------------------------------------------

class ListSchedulesTool extends ToolModel<Record<string, never>> {
  #state: StateTree;

  constructor(state: StateTree) {
    super({
      name: 'listSchedules',
      description: 'List all schedules for this agent.',
      parametersSchema: z.object({}),
      toolType: 'function',
    });
    this.#state = state;
  }

  async execute(
    _input: Record<string, never>,
    _ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    // Filter to direct-child schedule paths only. `state.list` matches any
    // nested path under the prefix, so orphans at a deeper path (e.g. from an
    // older path schema) would otherwise be swept into the result.
    const allPaths = await this.#state.list(SCHEDULE_STATE_PREFIX);
    const paths = allPaths.filter((p) => SCHEDULE_STATE_PATH_RE.test(p));
    const schedules: Array<{
      taskId: string;
      name: string;
      schedule: unknown;
      handler: string;
      enabled: boolean;
      nextRunAt?: string;
      lastRunAt?: string;
      lastRunStatus?: string;
    }> = [];

    for (const path of paths) {
      const data = await this.#state.get<Schedule>(path);
      if (data) {
        schedules.push({
          taskId: data.taskId,
          name: data.name,
          schedule: data.schedule,
          handler: data.handler,
          enabled: data.enabled,
          nextRunAt: data.nextRunAt || undefined,
          lastRunAt: data.lastRunAt,
          lastRunStatus: data.lastRunStatus,
        });
      }
    }

    return {
      output: JSON.stringify({ count: schedules.length, schedules }),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the 4 schedule tools. Auto-included in every agent.
 * Tools read/write to `/data/cron/{taskId}` in the state tree.
 */
export function createScheduleTools(state: StateTree): ToolModel[] {
  return [
    new CreateScheduleTool(state),
    new UpdateScheduleTool(state),
    new DeleteScheduleTool(state),
    new ListSchedulesTool(state),
  ];
}

export { CreateScheduleTool, UpdateScheduleTool, DeleteScheduleTool, ListSchedulesTool };
