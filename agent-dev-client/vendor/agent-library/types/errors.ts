import { isRecord } from '../util/type-guards.ts';

export class AgentRetryError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'AgentRetryError';
    this.cause = cause;
  }
}

export class AgentBudgetError extends Error {
  readonly budgetType: 'tokens' | 'turns' | 'time';
  constructor(message: string, budgetType: 'tokens' | 'turns' | 'time') {
    super(message);
    this.name = 'AgentBudgetError';
    this.budgetType = budgetType;
  }
}

/**
 * The model call returned no content and no output tokens. Distinct from a
 * provider error: the stream completes cleanly, it just carries nothing.
 */
export class EmptyModelResponseError extends Error {
  constructor() {
    super('The model returned an empty response');
    this.name = 'EmptyModelResponseError';
  }
}

export class FirstTokenTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`No response received from the model within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'FirstTokenTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Category of an LLM call failure, emitted alongside the user-facing terminal
 * message so API consumers branch on a stable code instead of parsing prose.
 */
export const LlmErrorCode = {
  platformProviderUnavailable: 'platform_provider_unavailable',
  providerRateLimited: 'provider_rate_limited',
  userQuotaExhausted: 'user_quota_exhausted',
  userCreditsExhausted: 'user_credits_exhausted',
  contextTooLong: 'context_too_long',
  modelOverloaded: 'model_overloaded',
  retryExhausted: 'retry_exhausted',
  budgetExhausted: 'budget_exhausted',
  unknown: 'unknown',
} as const;

export type LlmErrorCode = (typeof LlmErrorCode)[keyof typeof LlmErrorCode];

/**
 * Hosts throw an error with this `name` to stop a run when the wallet cannot
 * cover the next model call. The prototype may be lost after the error crosses
 * the model-provider fetch boundary, so callers match on `name`.
 *
 * This is a blocked-request outcome, not a runtime fault — log it below error.
 */
export const INSUFFICIENT_CREDITS_ERROR_NAME = 'InsufficientCreditsError';

const MAX_CREDIT_ERROR_UNWRAP_DEPTH = 5;

/**
 * The named credit-gate error, unwrapping AI SDK `RetryError.lastError` and
 * `Error.cause`. Duck-typed so this file stays browser-safe (no `ai` import).
 */
export function findInsufficientCreditsError(error: unknown): Error | null {
  return findInsufficientCreditsErrorAt(error, 0);
}

function findInsufficientCreditsErrorAt(error: unknown, depth: number): Error | null {
  if (error == null || depth > MAX_CREDIT_ERROR_UNWRAP_DEPTH) {
    return null;
  }
  if (error instanceof Error && error.name === INSUFFICIENT_CREDITS_ERROR_NAME) {
    return error;
  }
  if (isRecord(error) && 'lastError' in error) {
    const nested = findInsufficientCreditsErrorAt(error.lastError, depth + 1);
    if (nested) {
      return nested;
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findInsufficientCreditsErrorAt(error.cause, depth + 1);
  }
  return null;
}

export function isInsufficientCreditsError(error: unknown): boolean {
  return findInsufficientCreditsError(error) !== null;
}
