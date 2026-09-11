import type { PendingAction } from './turn-events.ts';
import type {
  StartTurnOutcome,
  VoiceFunctionToolDefinition,
  VoiceToolResult,
} from './voice-tool-contracts.ts';

export type { StartTurnOutcome } from './voice-tool-contracts.ts';

/**
 * The slice of a runtime's turn machinery the tool executor needs to start,
 * resume, inspect, and abort a session turn. Structural so the core never
 * touches a runtime's MessageProcessor/AgentSession/RunRegistry directly —
 * each runtime supplies its own adapter (deployed: `VoiceTurnGateway`,
 * builder: `RunRegistry`).
 */
export interface TurnPort {
  /**
   * Starts (or queues, if the session is busy) a turn carrying `text` as the
   * user's utterance. `opts.resume` additionally resolves a paused tool call
   * awaiting the visitor/user's on-screen answer — `text` still doubles as
   * the resume's tool-result output (see the answer-path JSDoc below for why
   * it must never be empty).
   */
  startTurn(
    text: string,
    opts?: { resume?: { toolCallId: string; output: string } },
  ): Promise<StartTurnOutcome>;
  /** Aborts the active run, if any. Returns whether something was actually running. */
  abortActiveRun(): Promise<boolean>;
  /** One-line human status of the current turn, for `get_session_status`-style tools. */
  sessionStatus(): string;
  /** Free-text search over this session's earlier turns, returned verbatim as the tool output. */
  searchHistory(query: string): Promise<string>;
}

/**
 * Vocabulary for the shared voice tools. Deployed and builder voice both use
 * `handle_request`; descriptions and answer-tool names remain role-specific.
 */
export interface VoiceToolVocabulary {
  forwardName: string;
  answerName: string;
  recallName: string;
  statusName: string;
  abortName: string;
  endName: string;
  descriptions: Record<string, string>;
}

/** Role-specific tools beyond the six shared ones (e.g. builder's `open_preview`). */
export interface RoleTools {
  definitions: VoiceFunctionToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<VoiceToolResult | null>;
}

export interface VoiceToolExecutorCoreDeps {
  port: TurnPort;
  vocab: VoiceToolVocabulary;
  /** The on-screen action currently awaiting an answer, or `null` if none is armed. */
  getArmedAction: () => PendingAction | null;
  clearArmedAction: () => void;
  onSessionEnd: () => void;
  roleTools?: RoleTools;
}

const FORWARD_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    instruction: {
      type: 'string',
      description:
        'The exact words, first person, as if they typed it themselves. Fix only transcription errors — never rephrase, summarize, or convert to third person.',
    },
    spokenSummary: {
      type: 'string',
      description: 'Short phrasing of what was asked for.',
    },
  },
  required: ['instruction'],
};

const EMPTY_PARAMETERS: Record<string, unknown> = { type: 'object', properties: {} };

const ANSWER_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'The chosen option’s value, or the free-text answer.',
    },
  },
  required: ['answer'],
};

const RECALL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What to search for in earlier parts of this session.',
    },
  },
  required: ['query'],
};

const SESSION_ENDING_RESULT: VoiceToolResult = {
  outcome: {
    status: 'completed',
    result: 'session-ending',
    value: 'Give one brief farewell now; the session closes right after it.',
  },
  speak: true,
};
const NOTHING_RUNNING_RESULT: VoiceToolResult = {
  outcome: { status: 'needs-input', reason: 'nothing-running' },
  speak: true,
};
const STOPPED_RESULT: VoiceToolResult = {
  outcome: { status: 'completed', result: 'stopped' },
  speak: true,
};
const NO_INSTRUCTION_RESULT: VoiceToolResult = {
  outcome: { status: 'needs-input', reason: 'missing-instruction' },
  speak: true,
};
/**
 * Nothing is armed, but the caller clearly wants something done to the screen
 * — the refusal must redirect, not dead-end: a bare reason gets narrated to
 * the listener as "there is no field awaiting input" instead of the model
 * routing the request through the forward tool in the same turn.
 */
function nothingAwaitingInputResult(forwardName: string): VoiceToolResult {
  return {
    outcome: {
      status: 'needs-input',
      reason: `nothing on screen is awaiting a selection right now. To put the caller's values into what they see (a form, a field) or change it, use ${forwardName}.`,
    },
    speak: true,
  };
}
const NO_ANSWER_RESULT: VoiceToolResult = {
  outcome: { status: 'needs-input', reason: 'missing-answer' },
  speak: true,
};
const NOT_POSSIBLE_BY_VOICE_RESULT: VoiceToolResult = {
  outcome: { status: 'failed', reason: 'unsupported-by-attachment' },
  speak: true,
};
const TOOL_FAILED_RESULT: VoiceToolResult = {
  outcome: { status: 'failed', reason: 'tool-error' },
  speak: true,
};

function optionMismatchResult(options: string[]): VoiceToolResult {
  return {
    outcome: { status: 'needs-input', reason: 'option-mismatch', options },
    speak: true,
  };
}

function statusResult(status: string): VoiceToolResult {
  return {
    outcome: { status: 'completed', result: 'session-status', value: status },
    speak: true,
  };
}

function descriptionFor(vocab: VoiceToolVocabulary, name: string): string {
  const description = vocab.descriptions[name];
  if (description === undefined) {
    throw new Error(`VoiceToolVocabulary is missing a description for tool "${name}"`);
  }
  return description;
}

/**
 * Builds the realtime tool schema for the five vocabulary-named core tools
 * plus recall. Names and per-tool descriptions come from `vocab`; parameter
 * shapes are lifted verbatim (same property names, same `required` lists)
 * from today's two `VOICE_TOOL_DEFINITIONS` arrays so the realtime model's
 * call shapes never change. Where the two arrays' property-level wording
 * diverged (e.g. "the visitor's" vs "the user's"), this module unifies it to
 * a role-neutral phrasing — the vocabulary only owns the top-level tool
 * description, not per-property text.
 */
export function buildVoiceToolDefinitions(
  vocab: VoiceToolVocabulary,
  roleTools?: Pick<RoleTools, 'definitions'>,
): VoiceFunctionToolDefinition[] {
  return [
    {
      type: 'function',
      name: vocab.forwardName,
      description: descriptionFor(vocab, vocab.forwardName),
      parameters: FORWARD_PARAMETERS,
    },
    {
      type: 'function',
      name: vocab.recallName,
      description: descriptionFor(vocab, vocab.recallName),
      parameters: RECALL_PARAMETERS,
    },
    {
      type: 'function',
      name: vocab.statusName,
      description: descriptionFor(vocab, vocab.statusName),
      parameters: EMPTY_PARAMETERS,
    },
    {
      type: 'function',
      name: vocab.abortName,
      description: descriptionFor(vocab, vocab.abortName),
      parameters: EMPTY_PARAMETERS,
    },
    {
      type: 'function',
      name: vocab.answerName,
      description: descriptionFor(vocab, vocab.answerName),
      parameters: ANSWER_PARAMETERS,
    },
    {
      type: 'function',
      name: vocab.endName,
      description: descriptionFor(vocab, vocab.endName),
      parameters: EMPTY_PARAMETERS,
    },
    ...(roleTools?.definitions ?? []),
  ];
}

/**
 * Shared tool-call contract for both voice runtimes (deployed, builder) over
 * a `TurnPort` + `VoiceToolVocabulary`. Consolidates the behavior that would
 * otherwise live twice, near-identically, in each runtime's own
 * `VoiceToolExecutor`.
 */
export class VoiceToolExecutorCore {
  #deps: VoiceToolExecutorCoreDeps;

  constructor(deps: VoiceToolExecutorCoreDeps) {
    this.#deps = deps;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<VoiceToolResult> {
    try {
      return await this.#dispatch(name, args);
    } catch {
      return this.#isDelegatingTool(name)
        ? this.#failedDelegation(TOOL_FAILED_RESULT)
        : TOOL_FAILED_RESULT;
    }
  }

  async #dispatch(name: string, args: Record<string, unknown>): Promise<VoiceToolResult> {
    const vocab = this.#deps.vocab;
    if (name === vocab.forwardName) {
      return this.#forward(args);
    }
    if (name === vocab.recallName) {
      return this.#recall(args);
    }
    if (name === vocab.statusName) {
      return statusResult(this.#deps.port.sessionStatus());
    }
    if (name === vocab.abortName) {
      return this.#abort();
    }
    if (name === vocab.answerName) {
      return this.#answer(args);
    }
    if (name === vocab.endName) {
      this.#deps.onSessionEnd();
      return SESSION_ENDING_RESULT;
    }
    if (this.#deps.roleTools) {
      const result = await this.#deps.roleTools.execute(name, args);
      if (result) {
        return result;
      }
    }
    return NOT_POSSIBLE_BY_VOICE_RESULT;
  }

  /**
   * Clears the armed action before `startTurn` regardless of outcome —
   * today's ordering (deployed clears `#pendingQuestion` at the top of
   * `#sendAgentMessage`, before the forward even runs). A forward is a fresh
   * instruction, not a resume of the armed action, so there is nothing to
   * retry it against.
   */
  async #forward(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
    if (!instruction) {
      return this.#failedDelegation(NO_INSTRUCTION_RESULT);
    }
    this.#deps.clearArmedAction();
    const outcome = await this.#deps.port.startTurn(instruction);
    return this.#resultFor(outcome);
  }

  async #recall(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const query = typeof args.query === 'string' ? args.query : '';
    const output = await this.#deps.port.searchHistory(query);
    return {
      outcome: { status: 'completed', result: 'conversation-recall', value: output },
      speak: true,
    };
  }

  async #abort(): Promise<VoiceToolResult> {
    const aborted = await this.#deps.port.abortActiveRun();
    return aborted ? STOPPED_RESULT : NOTHING_RUNNING_RESULT;
  }

  /**
   * The forwarded text is ALWAYS the non-empty resolved answer — never `''`.
   * Today's builder side forwards `instruction: ''` on a resume, which (a) is
   * rejected by `RunRegistry`'s empty-text queue gate when the session is
   * busy, silently discarding the answer, and (b) on a stale resume (the
   * question was already answered on screen) has nothing for
   * `applyResumeToolResults` to inject, so the run no-ops while voice reports
   * success. A non-empty `text` fixes both: a busy answer queues normally,
   * and a stale resume degrades to an ordinary user utterance the model can
   * react to. Accepted residual: on that stale path the answer reaches the
   * model as free text, without the resolved-question link.
   *
   * Unlike `#forward`, the armed action is cleared only once the outcome is
   * known, and only when the turn actually took (started or queued) — on
   * 'busy' the answer never reached the turn machinery, so the question is
   * still pending and the user should be able to retry it rather than lose
   * the arm.
   */
  async #answer(args: Record<string, unknown>): Promise<VoiceToolResult> {
    const action = this.#deps.getArmedAction();
    if (!action) {
      return this.#failedDelegation(nothingAwaitingInputResult(this.#deps.vocab.forwardName));
    }
    const answer = typeof args.answer === 'string' ? args.answer.trim() : '';
    if (!answer) {
      return this.#failedDelegation(NO_ANSWER_RESULT);
    }
    const option = action.options.find(
      (candidate) =>
        candidate.value.toLowerCase() === answer.toLowerCase() ||
        candidate.label.toLowerCase() === answer.toLowerCase(),
    );
    if (!option && action.options.length > 0) {
      const labels = action.options.map((candidate) => candidate.label);
      return this.#failedDelegation(optionMismatchResult(labels));
    }
    const outputText = option ? option.label : answer;
    const outcome = action.resume
      ? await this.#deps.port.startTurn(outputText, {
          resume: { toolCallId: action.resume.toolCallId, output: outputText },
        })
      : await this.#deps.port.startTurn(outputText);
    if (outcome.status !== 'busy') {
      this.#deps.clearArmedAction();
    }
    return this.#resultFor(outcome);
  }

  #resultFor(outcome: StartTurnOutcome): VoiceToolResult {
    if (outcome.status === 'queued') {
      return { outcome, speak: true, delegation: outcome };
    }
    if (outcome.status === 'busy') {
      return { outcome, speak: true, delegation: outcome };
    }
    return { outcome, speak: false, delegation: outcome };
  }

  #failedDelegation(result: VoiceToolResult): VoiceToolResult {
    return { ...result, delegation: { status: 'failed' } };
  }

  #isDelegatingTool(name: string): boolean {
    return name === this.#deps.vocab.forwardName || name === this.#deps.vocab.answerName;
  }
}
