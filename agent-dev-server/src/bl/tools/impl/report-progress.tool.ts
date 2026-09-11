/**
 * The agent's own voice into a conversation it cannot hear.
 *
 * A platform tool publishes a progress fact because it knows one — a checklist
 * step that changed, a source count that grew. Most work is not like that: it
 * runs inside tools the platform did not write, and nothing there knows what a
 * waiting person would want to hear. This tool closes that gap without anyone
 * writing per-tool text: the agent doing the work says one sentence, in the
 * moment, and it travels the same `UserFacingProgress` path a platform tool's
 * fact travels.
 *
 * It is granted only while someone is listening (`voiceActive`), because on a
 * screen the same information is already visible as it happens.
 *
 * What it must never become is narration of mechanics. The description below
 * is the contract, and the two rules that carry it are: report only what has
 * ALREADY happened, and never report the outcome — the outcome is delivered
 * when the turn ends, and claiming it early is how a caller is told their
 * booking is confirmed while it is still being made.
 */
import { z } from 'zod';
import {
  ToolModel,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';

/** Long enough for one spoken sentence, short enough that it cannot become a monologue. */
const MAX_PROGRESS_CHARS = 200;

const ReportProgressSchema = z.object({
  progress: z
    .string()
    .min(1)
    .max(MAX_PROGRESS_CHARS)
    .describe(
      'One short, concrete sentence about work you have ALREADY completed in this turn, in ' +
        'plain language a customer would use. Include real quantities when you have them ' +
        '("checked four of the six branches"). Never mention tools, systems, files or ' +
        'identifiers, never describe what you are about to do, and never state the result — ' +
        'the result is delivered when the turn finishes.',
    ),
});

type ReportProgressInput = z.infer<typeof ReportProgressSchema>;

export class ReportProgressTool extends ToolModel<ReportProgressInput> {
  constructor() {
    super({
      name: 'report_progress',
      description:
        'Tell the waiting person what you have done so far. Call this only when this turn is ' +
        'taking a while and you have finished something concrete they would care about — ' +
        'roughly once per meaningful milestone, never on a fast turn and never twice for the ' +
        'same thing. It speaks to them immediately and does not affect your work; keep going ' +
        'in the same turn.',
      parametersSchema: ReportProgressSchema,
      toolType: 'function',
      isStreaming: false,
      skipOffload: true,
    });
  }

  async execute(input: ReportProgressInput, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const text = input.progress.trim();
    if (!text) {
      return { output: 'Nothing to report.' };
    }
    return {
      output: 'Reported.',
      progress: { text: text.slice(0, MAX_PROGRESS_CHARS) },
    };
  }
}
