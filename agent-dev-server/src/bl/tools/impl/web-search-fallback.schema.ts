import { z } from 'zod';

/**
 * Input schema for the `web_search` tool.
 *
 * Lives in its own file (no agent-library dependency) so unit tests can
 * import it via `node --test` without pulling in the runtime's
 * extensionless-import chain.
 */
export const webSearchParamsSchema = z
  .object({
    query: z
      .string()
      .describe(
        "Complete search query that fully captures the user's intent. Include ALL relevant details from the user's request.",
      ),
    start_time: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        'Optional RFC 3339 / ISO 8601 timestamp marking the EARLIER (older) edge of the date range ' +
          '— results before this are excluded (e.g. "2026-05-12T00:00:00Z"). ' +
          'Use ONLY when the query is date-bounded. Must be paired with end_time. ' +
          'For relative ranges, call getCurrentTime first.',
      ),
    end_time: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        'Optional RFC 3339 / ISO 8601 timestamp marking the LATER (newer) edge of the date range ' +
          '— results after this are excluded. Must be paired with start_time and chronologically after it.',
      ),
  })
  .superRefine(({ start_time, end_time }, ctx) => {
    if ((start_time === undefined) !== (end_time === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_time and end_time must be provided together — either both or neither.',
      });
      return;
    }
    if (start_time !== undefined && end_time !== undefined) {
      // `.datetime({ offset: true })` already validated parseability — Date.parse is just for ordering.
      if (Date.parse(end_time) <= Date.parse(start_time)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'end_time must be strictly after start_time.',
        });
      }
    }
  });

export type WebSearchParams = z.infer<typeof webSearchParamsSchema>;
