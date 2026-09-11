import { APICallError } from '@ai-sdk/provider';
import { LlmErrorCode } from '../types/errors.ts';
import { isRecord } from '../util/type-guards.ts';

export { LlmErrorCode };

export type LlmRetryClassification = {
  shouldRetry: boolean;
  delayMs: number;
  userMessage?: string;
  triggerTruncation?: boolean;
  errorCode: LlmErrorCode;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '';
}

function parseResponseBody(responseBody: string | undefined): unknown {
  if (!responseBody) {
    return null;
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    return null;
  }
}

function collectStructuredText(parsed: unknown, fallbackMessage: string): string {
  const parts: string[] = [];
  if (fallbackMessage) {
    parts.push(fallbackMessage);
  }
  if (!isRecord(parsed)) {
    return parts.join(' ');
  }
  const topLevelCode = parsed['code'];
  if (typeof topLevelCode === 'string') {
    parts.push(topLevelCode);
  }
  const topLevelError = parsed['error'];
  if (typeof topLevelError === 'string') {
    parts.push(topLevelError);
  } else if (isRecord(topLevelError)) {
    const nestedCode = topLevelError['code'];
    if (typeof nestedCode === 'string') {
      parts.push(nestedCode);
    }
    const nestedMessage = topLevelError['message'];
    if (typeof nestedMessage === 'string') {
      parts.push(nestedMessage);
    }
  }
  return parts.join(' ');
}

function isUserCreditsExhausted(error: APICallError): boolean {
  if (error.statusCode === 402) {
    return true;
  }
  if (typeof error.responseBody === 'string') {
    return error.responseBody.includes('credits_exhausted');
  }
  return false;
}

function isUserQuotaExhausted(error: APICallError): boolean {
  if (typeof error.responseBody === 'string') {
    return error.responseBody.includes('conversation_agent_calls_exhausted');
  }
  return false;
}

/**
 * Billing exhaustion the platform itself reported for this user. Both codes are
 * emitted by our own gateway, so they are matched exactly rather than by keyword.
 */
function classifyUserBilling(error: APICallError): LlmRetryClassification | null {
  if (isUserCreditsExhausted(error)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.userCreditsExhausted,
    };
  }
  if (isUserQuotaExhausted(error)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.userQuotaExhausted,
    };
  }
  return null;
}

/**
 * Provider-side account exhaustion (platform key out of credits, spending cap, etc.).
 * Must not match user billing signals handled by {@link classifyUserBilling}.
 */
function isPlatformProviderUnavailable(error: APICallError): boolean {
  const parsed = parseResponseBody(error.responseBody);
  const text = collectStructuredText(parsed, error.message).toLowerCase();

  if (isRecord(parsed)) {
    const topLevelCode = parsed['code'];
    if (topLevelCode === 'permission-denied') {
      return true;
    }
    const nestedError = parsed['error'];
    if (isRecord(nestedError) && nestedError['code'] === 'permission-denied') {
      return true;
    }
  }

  if (error.statusCode === 403 || error.statusCode === 401) {
    if (text.includes('spending limit')) {
      return true;
    }
    if (text.includes('purchase more credits')) {
      return true;
    }
    if (text.includes('used all available credits')) {
      return true;
    }
    if (text.includes('permission-denied')) {
      return true;
    }
  }

  return false;
}

/**
 * Structured LLM error classification for retryPolicy.
 * Returns null when no known category applies.
 */
export function classifyLlmRetryError(error: unknown): LlmRetryClassification | null {
  const apiError = APICallError.isInstance(error) ? error : null;

  if (apiError) {
    const billing = classifyUserBilling(apiError);
    if (billing) {
      return billing;
    }

    // Provider-capacity 429 (transient). Must precede the message-keyword
    // branches below: provider 429 text often mentions overload or limits,
    // and real user billing is caught above.
    if (apiError.statusCode === 429) {
      return {
        shouldRetry: true,
        delayMs: 5000,
        errorCode: LlmErrorCode.providerRateLimited,
      };
    }
  }

  const message = errorMessage(error);

  if (message.includes('too long')) {
    return {
      shouldRetry: true,
      delayMs: 0,
      triggerTruncation: true,
      errorCode: LlmErrorCode.contextTooLong,
    };
  }

  if (message.includes('Overloaded')) {
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.modelOverloaded,
    };
  }

  if (apiError && isPlatformProviderUnavailable(apiError)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      errorCode: LlmErrorCode.platformProviderUnavailable,
    };
  }

  return null;
}
