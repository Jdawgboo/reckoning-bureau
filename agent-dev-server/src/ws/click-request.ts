/**
 * Turns `metadata.a2uiActionByName: { button, context? }` into the `metadata.a2uiAction` a
 * browser click carries, or fails with the captions that were available. Runs before a turn
 * exists, so an unhonourable request costs nothing. Separate from the transport handlers
 * because both entry points need it and neither owns it.
 */

import { isRecord } from '../util/type-guards.ts';
import type { ClickFailure, ClickResolution } from './a2ui-click-resolver.ts';

export const CLICK_BY_NAME_KEY = 'a2uiActionByName';

export class ClickResolutionError extends Error {}

export interface ClickRequest {
  button: string;
  /** Values for context fields the screen cannot supply, e.g. what a visitor would type. */
  context?: Record<string, unknown>;
}

export function readClickRequest(metadata: unknown): ClickRequest | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const request = metadata[CLICK_BY_NAME_KEY];
  if (!isRecord(request) || typeof request.button !== 'string' || !request.button.trim()) {
    return null;
  }
  const context = isRecord(request.context) ? request.context : undefined;
  return context ? { button: request.button, context } : { button: request.button };
}

/** True for a malformed request too, so it can be reported rather than ignored. */
export function hasClickRequest(metadata: unknown): boolean {
  return isRecord(metadata) && metadata[CLICK_BY_NAME_KEY] !== undefined;
}

/**
 * Returns browser-equivalent metadata plus the message text the press produces, or null when
 * this is not a click. A control with no declared action behind it (a TextBlock button) sends
 * its intent as an ordinary message, so no `a2uiAction` is attached and the channel stays as
 * the caller's — that is what the browser does too.
 *
 * @throws ClickResolutionError when the named control cannot be pressed.
 */
export function resolveClickMetadata(
  metadata: Record<string, unknown> | undefined,
  resolve: (request: ClickRequest) => ClickResolution,
): { metadata: Record<string, unknown>; message: string; isAction: boolean } | null {
  const request = readClickRequest(metadata);
  if (!request) {
    if (hasClickRequest(metadata)) {
      throw new ClickResolutionError(
        `${CLICK_BY_NAME_KEY} must be an object with a non-empty "button" string`,
      );
    }
    return null;
  }

  const resolution = resolve(request);
  if (resolution.outcome !== 'resolved') {
    throw new ClickResolutionError(describeFailure(request.button, resolution));
  }

  const { [CLICK_BY_NAME_KEY]: _request, ...rest } = metadata ?? {};
  if (resolution.action === null) {
    return { metadata: rest, message: resolution.message, isAction: false };
  }

  return {
    metadata: {
      ...rest,
      channel: 'screen',
      a2uiAction: {
        surfaceId: resolution.surfaceId,
        name: resolution.action,
        context: resolution.context,
      },
    },
    message: resolution.message,
    isAction: true,
  };
}

function quoted(caption: string): string {
  return `"${caption}"`;
}

function describeFailure(button: string, resolution: ClickFailure): string {
  if (resolution.outcome === 'no_surface') {
    return `Cannot press "${button}": no screen is currently rendered.`;
  }

  if (resolution.outcome === 'not_found') {
    const available = resolution.available.length
      ? resolution.available.map(quoted).join(', ')
      : 'none';
    return `Nothing on the current screen matches "${button}". Available controls: ${available}.`;
  }

  if (resolution.outcome === 'ambiguous') {
    return (
      `"${button}" matches ${resolution.matches.length} controls: ` +
      `${resolution.matches.map(quoted).join(', ')}. ` +
      `Name one exactly rather than letting it be guessed.`
    );
  }

  if (resolution.outcome === 'unavailable') {
    return `"${resolution.caption}" is on screen but cannot be pressed: ${resolution.reason}.`;
  }

  if (resolution.outcome === 'context_required') {
    return (
      `"${button}" needs values a visitor would have entered: ` +
      `${resolution.missing.join(', ')}. Supply them as the press context.`
    );
  }

  const withheld = resolution.skippedSensitiveChecks.length
    ? ` Checks on ${resolution.skippedSensitiveChecks.join(', ')} were skipped, because ` +
      `values of those field kinds never reach the server.`
    : '';
  return `"${button}" is blocked by validation: ${resolution.messages.join('; ')}.${withheld}`;
}
