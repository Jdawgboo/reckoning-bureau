import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  CLICK_BY_NAME_KEY,
  ClickResolutionError,
  hasClickRequest,
  readClickRequest,
  resolveClickMetadata,
} from './click-request.ts';
import type { ClickResolution } from './a2ui-click-resolver.ts';

const RESOLVED: ClickResolution = {
  outcome: 'resolved',
  surfaceId: 'booking',
  action: 'confirmBooking',
  context: { email: 'visitor@example.com' },
  message: 'confirmBooking',
  skippedSensitiveChecks: [],
};

const PLAIN_MESSAGE: ClickResolution = {
  outcome: 'resolved',
  surfaceId: 'booking',
  action: null,
  context: {},
  message: 'I want to book a visit',
  skippedSensitiveChecks: [],
};

function always(resolution: ClickResolution) {
  return () => resolution;
}

describe('readClickRequest', () => {
  it('reads a well-formed request', () => {
    assert.deepStrictEqual(
      readClickRequest({ [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } }),
      { button: 'Confirm booking' },
    );
  });

  it('reads the context a caller supplied for values only a visitor could type', () => {
    assert.deepStrictEqual(
      readClickRequest({
        [CLICK_BY_NAME_KEY]: { button: 'Confirm booking', context: { email: 'a@b.c' } },
      }),
      { button: 'Confirm booking', context: { email: 'a@b.c' } },
    );
  });

  it('ignores a non-object context rather than passing it on', () => {
    assert.deepStrictEqual(
      readClickRequest({ [CLICK_BY_NAME_KEY]: { button: 'Confirm', context: 'a@b.c' } }),
      { button: 'Confirm' },
    );
  });

  it('returns null when the message is not a click', () => {
    assert.strictEqual(readClickRequest({ channel: 'http' }), null);
    assert.strictEqual(readClickRequest(undefined), null);
  });

  it('returns null for a malformed request', () => {
    assert.strictEqual(readClickRequest({ [CLICK_BY_NAME_KEY]: { button: '  ' } }), null);
    assert.strictEqual(readClickRequest({ [CLICK_BY_NAME_KEY]: 'Confirm' }), null);
  });
});

describe('hasClickRequest', () => {
  it('is true for a malformed request too, so it can be reported rather than ignored', () => {
    assert.strictEqual(hasClickRequest({ [CLICK_BY_NAME_KEY]: 'Confirm' }), true);
    assert.strictEqual(hasClickRequest({ channel: 'http' }), false);
  });
});

describe('resolveClickMetadata', () => {
  it('returns null for a plain message, leaving it untouched', () => {
    assert.strictEqual(resolveClickMetadata({ channel: 'http' }, always(RESOLVED)), null);
  });

  it('replaces the by-name request with the trusted action and tags the screen channel', () => {
    const result = resolveClickMetadata(
      { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' }, requestType: 'test' },
      always(RESOLVED),
    );

    assert.deepStrictEqual(result, {
      metadata: {
        requestType: 'test',
        channel: 'screen',
        a2uiAction: {
          surfaceId: 'booking',
          name: 'confirmBooking',
          context: { email: 'visitor@example.com' },
        },
      },
      message: 'confirmBooking',
      isAction: true,
    });
  });

  it('sends a control with no declared action as a plain message, with no forged action', () => {
    const result = resolveClickMetadata(
      { [CLICK_BY_NAME_KEY]: { button: 'Book a visit' }, requestType: 'test' },
      always(PLAIN_MESSAGE),
    );

    assert.deepStrictEqual(result, {
      metadata: { requestType: 'test' },
      message: 'I want to book a visit',
      isAction: false,
    });
  });

  it('does not leave the by-name key in the metadata it returns', () => {
    const result = resolveClickMetadata(
      { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } },
      always(RESOLVED),
    );

    assert.strictEqual(CLICK_BY_NAME_KEY in (result?.metadata ?? {}), false);
  });

  it('throws on a malformed request rather than silently sending a plain message', () => {
    assert.throws(
      () => resolveClickMetadata({ [CLICK_BY_NAME_KEY]: 'Confirm' }, always(RESOLVED)),
      (err: unknown) =>
        err instanceof ClickResolutionError && /must be an object/.test(err.message),
    );
  });

  it('names the available captions when nothing matched', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'Pay now' } },
          always({ outcome: 'not_found', available: ['Confirm booking', 'Cancel'] }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError &&
        err.message.includes('"Confirm booking", "Cancel"') &&
        err.message.includes('Nothing on the current screen matches "Pay now"'),
    );
  });

  it('distinguishes ambiguity from no match and lists only the collisions', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'confirm' } },
          always({ outcome: 'ambiguous', matches: ['Confirm booking', 'Confirm cancellation'] }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError &&
        err.message.includes('matches 2 controls') &&
        !err.message.includes('Nothing on the current screen'),
    );
  });

  it('names the values it needs when the screen cannot supply them', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } },
          always({ outcome: 'context_required', action: 'confirmBooking', missing: ['email'] }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError &&
        err.message.includes('needs values a visitor would have entered: email'),
    );
  });

  it('says a control is present but not pressable, rather than not found', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: '18:00' } },
          always({ outcome: 'unavailable', caption: '18:00', reason: 'disabled' }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError &&
        err.message.includes('cannot be pressed: disabled') &&
        !err.message.includes('Nothing on the current screen'),
    );
  });

  it('says so when no screen is rendered', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } },
          always({ outcome: 'no_surface' }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError && /no screen is currently rendered/.test(err.message),
    );
  });

  it('reports validation messages, and mentions skipped sensitive checks when there are any', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } },
          always({
            outcome: 'checks_failed',
            messages: ['Email is required'],
            skippedSensitiveChecks: ['cardNumber'],
          }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError &&
        err.message.includes('Email is required') &&
        err.message.includes('Checks on cardNumber were skipped'),
    );
  });

  it('omits the sensitive-field note when nothing was skipped', () => {
    assert.throws(
      () =>
        resolveClickMetadata(
          { [CLICK_BY_NAME_KEY]: { button: 'Confirm booking' } },
          always({
            outcome: 'checks_failed',
            messages: ['Email is required'],
            skippedSensitiveChecks: [],
          }),
        ),
      (err: unknown) =>
        err instanceof ClickResolutionError && !err.message.includes('were skipped'),
    );
  });
});
