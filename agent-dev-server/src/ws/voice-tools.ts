/**
 * Deployed voice tool bridge — vocabulary + `TurnPort` adapter that wire the
 * shared `VoiceToolExecutorCore` onto this runtime's real turn machinery.
 * `handle_request` starts a REAL session turn (via the VoiceTurnGateway
 * the ws voice gateway adapts over MessageProcessor), indistinguishable from
 * an omnibox send: same responseId flow, same broadcast/logging path
 * (the attachment supplies `metadata.channel` for downstream attribution).
 */
import type {
  RoleTools,
  StartTurnOutcome,
  TurnPort,
  VoiceToolVocabulary,
} from '../../vendor/agentplace-voice/voice-tool-executor.ts';
import type { VoiceClientLink } from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import type { VoiceToolResult } from '../../vendor/agentplace-voice/voice-tool-contracts.ts';
import type { SessionPresentationLocale } from '../../../shared/index.ts';

/** The six front-desk tool names mapped onto the shared executor core's
 *  role-neutral vocabulary. */
export const DEPLOYED_VOICE_VOCABULARY: VoiceToolVocabulary = {
  forwardName: 'handle_request',
  answerName: 'answer_pending_action',
  recallName: 'recall_conversation',
  statusName: 'get_session_status',
  abortName: 'abort_current_run',
  endName: 'end_voice_session',
  descriptions: {
    handle_request:
      'Handle a request that requires current business state, capability, action, or an answer not explicit in delivered conversation or the validated current screen. Do not call for a fact already explicit there. Use a brief preamble only when the operation will be noticeable. The preamble only acknowledges — it never predicts the result, refuses, or describes how the work happens. Returns at once; the run result arrives later and establishes the outcome. If work is already in progress the request may queue.',
    recall_conversation:
      'Search earlier parts of THIS session that are not in your context. Use it when the visitor references something from earlier. Returns quotes of what was actually said — history, not proof that a fact is still current. Requests that require fresh state or act on the world still use handle_request.',
    get_session_status: 'Check how the current request is going and what changed recently.',
    abort_current_run:
      'Stop the work in progress. Call when the visitor asks to stop, cancel, or change course. To redirect: call this, then use handle_request for the new instruction.',
    answer_pending_action:
      'Answer a choice the front desk explicitly asked and armed (the pending action in your context). ONLY for that pending question. Never for filling or changing forms, fields, or anything else the visitor sees — use handle_request for those requests. Pass the VALUE of the option the visitor chose; free text is allowed when no option matches a text question.',
    end_voice_session:
      'End this voice session. Call as soon as the visitor says goodbye or asks to stop talking — do not say goodbye yet: the tool returns you one final turn, and that turn is where you give one brief farewell.',
  },
};

/**
 * The slice of the session's turn machinery the voice bridge needs —
 * structural so the executor core never touches MessageProcessor/AgentSession
 * directly (the gateway supplies the adapter).
 */
export interface VoiceTurnGateway {
  /** Starts a real session turn — same path as an omnibox send. */
  startTurn(content: string): Promise<{ queued: boolean; responseId: string }>;
  abortRun(responseId: string): Promise<void>;
  activeResponseId(): string | undefined;
  sessionStatus(): string;
  /** Free-text keyword search over this session's earlier turns, for the
   *  `recall_conversation` tool. */
  searchHistory(query: string): Promise<string>;
}

export interface TurnPortDeps {
  turns: VoiceTurnGateway;
  /** Reports a started run so its response stream can attach by responseId. */
  onRunStarted: (responseId: string) => void;
}

/** The exact message `MessageProcessor.handleMessageSend` throws when the
 *  session's one-deep queue already holds a pending message — the only throw
 *  `createTurnPort` treats as `'busy'`; every other error rethrows. */
const QUEUE_FULL_MESSAGE = 'Message already pending';

/**
 * Adapts this runtime's `VoiceTurnGateway` to the shared executor core's
 * `TurnPort`. `opts.resume` (accepted by `TurnPort.startTurn`) is
 * intentionally never read — the deployed runtime has no resumeToolResults
 * path (that is a builder-only capability), so an answer always forwards as
 * a plain new turn, same as before this migration.
 */
export function createTurnPort(deps: TurnPortDeps): TurnPort {
  return {
    startTurn: async (text): Promise<StartTurnOutcome> => {
      try {
        const result = await deps.turns.startTurn(text);
        if (result.queued) {
          return { status: 'queued', runId: result.responseId };
        }
        deps.onRunStarted(result.responseId);
        return { status: 'started', runId: result.responseId };
      } catch (error) {
        if (error instanceof Error && error.message === QUEUE_FULL_MESSAGE) {
          return { status: 'busy' };
        }
        throw error;
      }
    },
    abortActiveRun: async () => {
      const responseId = deps.turns.activeResponseId();
      if (!responseId) {
        return false;
      }
      await deps.turns.abortRun(responseId);
      return true;
    },
    sessionStatus: () => deps.turns.sessionStatus(),
    searchHistory: (query) => deps.turns.searchHistory(query),
  };
}

const REMEMBER_THIS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'ONE short third-person sentence stating the fact to remember, e.g. "The visitor is vegetarian." ',
    },
  },
  required: ['summary'],
};

const REMEMBER_THIS_DESCRIPTION =
  'Remember a lasting fact the visitor just told you about themselves — preferences, personal details, what they are looking for, or their goal. Use it the moment they share something worth recalling in a future conversation. Do NOT use it for one-off transactional details (a specific date, a booking already made) — those belong in the request handled with handle_request.';

const NOTED_RESULT: VoiceToolResult = {
  outcome: { status: 'completed', result: 'memory-recorded' },
  speak: false,
};
const NO_SUMMARY_RESULT: VoiceToolResult = {
  outcome: { status: 'needs-input', reason: 'missing-memory-summary' },
  speak: false,
};

/**
 * The deployed-only `remember_this` role tool: sends a `voice.memory`
 * command over the connection's event sink so the browser's
 * MemoryStore — the same one `persistToMemoryBank` writes to from the UI
 * model — gains an entry from a purely spoken exchange. Silent on success:
 * the model already acknowledged conversationally, same rationale as the
 * forward tool's `speak: false`. Shape mirrors `createOpenPreviewRoleTools`
 * (`packages/server/src/bl/voice/voice-gateway-ws.service.ts`).
 */
export function createMemoryRoleTools(events: Pick<VoiceClientLink, 'send'>): RoleTools {
  return {
    definitions: [
      {
        type: 'function',
        name: 'remember_this',
        description: REMEMBER_THIS_DESCRIPTION,
        parameters: REMEMBER_THIS_PARAMETERS,
      },
    ],
    execute: async (name, args) => {
      if (name !== 'remember_this') {
        return null;
      }
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) {
        return NO_SUMMARY_RESULT;
      }
      events.send({ type: 'voice.memory', summary });
      return NOTED_RESULT;
    },
  };
}

const SET_SESSION_LOCALE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    locale: {
      type: 'string',
      description: 'One canonical BCP-47 language tag, such as fr, ru, or pt-BR.',
    },
    evidence: {
      type: 'string',
      enum: ['explicit', 'conversation'],
      description:
        "Use explicit only for a direct language request. Use conversation when the visitor's " +
        'complete utterance is clearly in another language and no explicit preference is locked, ' +
        'even without a switch request. An unambiguous one-word greeting counts; never use a ' +
        'name, place, address, code, URL, ambiguous shared token such as “OK”, or a mixed-language ' +
        'fragment.',
    },
  },
  required: ['locale', 'evidence'],
  additionalProperties: false,
};

interface VoiceLocaleRoleToolsOptions {
  hasScreen: boolean;
  propose(locale: string, source: 'explicit' | 'conversation'): Promise<SessionPresentationLocale>;
  onCommitted(locale: SessionPresentationLocale): void;
}

export function createLocaleRoleTools(options: VoiceLocaleRoleToolsOptions): RoleTools {
  return {
    definitions: [
      {
        type: 'function',
        name: 'set_session_locale',
        description:
          'Commit the conversation language before replying to a direct language request or ' +
          'a complete utterance clearly in another language when no explicit preference is ' +
          'locked. Only a later direct request can replace an explicit preference. An unambiguous ' +
          'one-word greeting counts. This changes new speech and dynamic response ' +
          'content; stable screen labels activate separately after a complete browser bundle is ' +
          'installed.',
        parameters: SET_SESSION_LOCALE_PARAMETERS,
      },
    ],
    execute: async (name, args) => {
      if (name !== 'set_session_locale') {
        return null;
      }
      const locale = canonicalLocale(args['locale']);
      const evidence = args['evidence'];
      const keys = Object.keys(args);
      const exactShape = keys.length === 2 && keys.includes('locale') && keys.includes('evidence');
      if (!exactShape || !locale || (evidence !== 'explicit' && evidence !== 'conversation')) {
        return {
          outcome: { status: 'needs-input', reason: 'invalid-locale-proposal' },
          speak: false,
        };
      }
      const committed = await options.propose(locale, evidence);
      options.onCommitted(committed);
      return {
        outcome: {
          status: 'completed',
          result: 'locale-committed',
          value:
            `Conversation language is ${committed.messageLocale}. ` +
            (options.hasScreen
              ? "Before replying, use handle_request with the visitor's full request so the agent " +
                'can restate the current answer and update existing screen wording in this language. ' +
                'Include that facts and entered values must be preserved and completed actions must ' +
                "not be repeated. Wait for that run's result before speaking the answer. "
              : 'Reply in it now. ') +
            'Do not claim stable screen labels changed.',
        },
        speak: true,
      };
    },
  };
}

export function composeRoleTools(...sets: RoleTools[]): RoleTools {
  return {
    definitions: sets.flatMap((set) => set.definitions),
    execute: async (name, args) => {
      for (const set of sets) {
        const result = await set.execute(name, args);
        if (result) {
          return result;
        }
      }
      return null;
    },
  };
}

function canonicalLocale(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value) {
    return null;
  }
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 && canonical[0] === value ? value : null;
  } catch {
    return null;
  }
}
