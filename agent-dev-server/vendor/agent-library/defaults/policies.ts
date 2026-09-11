import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';
import type { RetryPolicy, StopPolicy, TurnPolicy } from '../kernel/policies.ts';
import { EmptyModelResponseError, FirstTokenTimeoutError } from '../types/errors.ts';
import { isRecord } from '../util/type-guards.ts';
import { classifyLlmRetryError, LlmErrorCode } from './llm-error.ts';

export { LlmErrorCode };

/**
 * Default stop policy - no automatic stopping at tool names.
 * Override this in application code to stop at specific tools (e.g., component tools).
 */
export const stopPolicy: StopPolicy = () => ({});

/**
 * The OpenAI Responses API delivers a failed response two ways: wrapped in an
 * `APICallError` when the stream dies before any output, and as a bare frame
 * enqueued on the error channel once output has started.
 */
function readResponseFailedFrame(error: unknown): Record<string, unknown> | null {
  if (isRecord(error) && error['type'] === 'response.failed') {
    return error;
  }
  if (!APICallError.isInstance(error) || typeof error.responseBody !== 'string') {
    return null;
  }
  try {
    const body: unknown = JSON.parse(error.responseBody);
    return isRecord(body) && body['type'] === 'response.failed' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Detects an upstream failure the provider reported as its own internal error,
 * regardless of how the SDK classified it: these carry the error code
 * `invalid_prompt`, which `@ai-sdk/openai` maps to HTTP 400 with
 * `isRetryable: false`, so an upstream 500 arrives looking like a client error.
 * Keyed on the message rather than the code, because `invalid_prompt` also
 * covers genuinely rejected prompts, which must not be retried.
 */
function isProviderInternalError(error: unknown): boolean {
  const frame = readResponseFailedFrame(error);
  if (!frame) {
    return false;
  }
  const response = frame['response'];
  if (!isRecord(response)) {
    return false;
  }
  const responseError = response['error'];
  if (!isRecord(responseError) || typeof responseError['message'] !== 'string') {
    return false;
  }
  return responseError['message'].toLowerCase().includes('internal server error');
}

export const retryPolicy: RetryPolicy = ({ error, retries, maxRetries }) => {
  if (retries >= maxRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.retryExhausted,
    };
  }

  // Classify the provider error the AI SDK wrapped in RetryError, not the wrapper.
  const inner = RetryError.isInstance(error) ? (error.lastError ?? error) : error;
  const message =
    inner instanceof Error ? inner.message : typeof inner === 'string' ? inner : 'unknown';

  if (inner instanceof FirstTokenTimeoutError) {
    return { shouldRetry: true, delayMs: 2000 };
  }

  if (inner instanceof EmptyModelResponseError) {
    return { shouldRetry: true, delayMs: 1000 };
  }

  const classified = classifyLlmRetryError(inner);
  if (classified) {
    return classified;
  }

  if (message.includes('terminated')) {
    return { shouldRetry: true, delayMs: 1000 };
  }

  if (isProviderInternalError(inner)) {
    return { shouldRetry: true, delayMs: 1000 };
  }

  if (APICallError.isInstance(inner)) {
    // Intermittent Bedrock error that randomly occurs even with a valid long-lived API key.
    // AWS token validation endpoint occasionally returns 403 — retrying resolves it.
    if (message.includes('The security token included in the request is invalid.')) {
      return { shouldRetry: true, delayMs: 2000 };
    }
    if (inner.isRetryable) {
      return { shouldRetry: true, delayMs: 1000 };
    }
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.unknown,
    };
  }

  return {
    shouldRetry: false,
    delayMs: 0,
    errorCode: LlmErrorCode.unknown,
  };
};

/**
 * Default behavior: stop after a single turn.
 */
export const turnPolicy: TurnPolicy = async () => ({ shouldStop: true });

export const policies = {
  stop: stopPolicy,
  retry: retryPolicy,
  turn: turnPolicy,
} satisfies {
  stop: StopPolicy;
  retry: RetryPolicy;
  turn: TurnPolicy;
};
