import assert from 'node:assert';
import { describe, it } from 'node:test';
import { LocalizationFormatter } from './localization-formatter.ts';

const formatter = new LocalizationFormatter();

describe('LocalizationFormatter', () => {
  it('formats ICU plural and numbers in the requested formatting locale', () => {
    const bundle = {
      locale: 'fr',
      messages: {
        bookings: '{count, plural, one {# réservation} other {# réservations}}',
        total: 'Total : {amount, number}',
      },
    };
    assert.strictEqual(
      formatter.format(bundle, 'fr-FR', 'bookings', { count: 1 }),
      '1 réservation',
    );
    assert.strictEqual(
      formatter.format(bundle, 'fr-FR', 'bookings', { count: 2 }),
      '2 réservations',
    );
    assert.match(
      formatter.format(bundle, 'fr-FR', 'total', { amount: 1234.5 }),
      /1[\s\u202f]234,5/,
    );
  });

  it('fails closed for a missing message id', () => {
    assert.throws(
      () => formatter.format({ locale: 'en', messages: {} }, 'en', 'missing'),
      /does not contain/,
    );
  });
});
