import { findInsufficientCreditsError } from '../types/errors.ts';
import { getAgentLogger, type AgentLogger } from '../types/logger.ts';
import { normalizeError } from './normalize-error.ts';

/**
 * Log a run/stream failure at the right severity. Credit-gate rejections are a
 * normal blocked-request outcome and must not go out at error (hosts capture
 * `error` as exceptions).
 */
export function logAgentError(
  message: string,
  error: unknown,
  logger: AgentLogger = getAgentLogger(),
): void {
  const creditError = findInsufficientCreditsError(error);
  if (creditError) {
    logger.info(message, { error: creditError.message });
    return;
  }
  logger.error(message, { error: normalizeError(error) });
}
