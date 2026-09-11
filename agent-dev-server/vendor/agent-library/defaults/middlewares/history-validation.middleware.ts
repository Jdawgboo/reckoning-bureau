import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type {
  KernelModelMiddleware,
  KernelModelMiddlewareContext,
} from '../../kernel/middlewares/types.ts';
import { getAgentLogger } from '../../types/logger.ts';
import { checkProviderContract, type ContractViolation } from '../validation/provider-contract.ts';

const logger = getAgentLogger();

export type HistoryValidationMode = 'off' | 'log' | 'enforce';

export type HistoryValidationOptions = {
  /**
   * `log` (default) records violations and sends the request anyway — safe to
   * roll out everywhere, because it cannot change behaviour.
   * `enforce` throws before the request is sent.
   * `off` skips the check entirely.
   */
  mode?: HistoryValidationMode;
  /**
   * Reject a tool-call id used twice in one request. Off by default: providers
   * that mint per-response ids (Bedrock Mantle) legitimately repeat an id across
   * turns, and the fleet runs that successfully.
   */
  strictToolCallIdUniqueness?: boolean;
  /** Identifies the surface in logs — 'builder', 'role', 'deployed', 'subagent'. */
  surface?: string;
};

/**
 * Validates the outgoing prompt against the strictest provider's acceptance
 * rules, immediately before it is sent.
 *
 * The gap this closes: nothing checked the prompt, and providers disagree on
 * strictness — Claude and Gemini silently accept malformed history where the
 * OpenAI Responses API rejects it. That asymmetry is the entire reason a series
 * of history-corruption defects presented as "GPT-only" and survived months of
 * clean-looking forensics. A prompt that only survives because a provider is
 * lenient is not one we want to ship.
 *
 * Runs LAST in the chain, so it sees exactly what the provider will: after
 * compaction, cache annotation and the budget guard have all had their say.
 *
 * Default `log`. Deliberately not `enforce` on arrival — enforcing a contract
 * that has never run against production traffic would turn an observability
 * change into an outage. Soak in `log`, compare the violation rate against what
 * builder-lab predicts, and only then enforce. If production disagrees with the
 * lab, the lab is wrong and gets fixed first.
 *
 * The rules live in `../validation/provider-contract.ts`, shared verbatim with
 * builder-lab's strict scripted provider — one implementation, so the guard and
 * the thing that models it cannot drift apart.
 */
export class HistoryValidationMiddleware implements KernelModelMiddleware {
  readonly #mode: HistoryValidationMode;
  readonly #strictToolCallIdUniqueness: boolean;
  readonly #surface?: string;

  constructor(options: HistoryValidationOptions = {}) {
    this.#mode = options.mode ?? 'log';
    this.#strictToolCallIdUniqueness = options.strictToolCallIdUniqueness ?? false;
    this.#surface = options.surface;
  }

  create(_ctx: KernelModelMiddlewareContext): LanguageModelMiddleware {
    const mode = this.#mode;
    const strictToolCallIdUniqueness = this.#strictToolCallIdUniqueness;
    const surface = this.#surface;

    return {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        if (mode === 'off') return params;

        const opts = params as LanguageModelV3CallOptions;
        let violations: ContractViolation[];
        try {
          violations = checkProviderContract(opts.prompt, { strictToolCallIdUniqueness });
        } catch (error) {
          logger.warn('[HistoryValidation] validator threw; request sent unchecked', {
            surface,
            error: error instanceof Error ? error.message : String(error),
          });
          return params;
        }

        if (violations.length === 0) return params;

        const codes = violations.map((v) => v.code);
        logger.warn('[HistoryValidation] outgoing prompt violates the provider contract', {
          surface,
          mode,
          codes,
          messageCount: opts.prompt.length,
          details: violations.slice(0, 5).map((v) => v.message),
        });

        if (mode === 'enforce') {
          throw new Error(
            `History validation failed before send (${codes.join(', ')}): ${violations[0].message}`,
          );
        }
        return params;
      },
    };
  }
}
