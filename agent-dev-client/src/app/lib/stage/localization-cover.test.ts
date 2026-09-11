import assert from 'node:assert';
import { describe, it } from 'node:test';
import { resolveLocalizationCover, type LocalizationCoverTarget } from './localization-cover.ts';

const ACTIVE: LocalizationCoverTarget = { messageLocale: 'ru', formatLocale: 'ru-RU' };

describe('resolveLocalizationCover', () => {
  it('covers a pending navigator or conversation locale resolution', () => {
    assert.deepStrictEqual(
      resolveLocalizationCover({
        transition: { status: 'pending', messageLocale: 'ka', formatLocale: 'ka-GE' },
        activeTarget: ACTIVE,
        heldTarget: null,
        localeActivationChanged: false,
        runActive: false,
      }),
      {
        visibleTarget: { messageLocale: 'ka', formatLocale: 'ka-GE' },
        heldTarget: null,
      },
    );
  });

  it('holds a newly activated locale until its text run settles', () => {
    const activated = resolveLocalizationCover({
      transition: { status: 'idle' },
      activeTarget: ACTIVE,
      heldTarget: null,
      localeActivationChanged: true,
      runActive: true,
    });
    assert.deepStrictEqual(activated, { visibleTarget: ACTIVE, heldTarget: ACTIVE });
    assert.deepStrictEqual(
      resolveLocalizationCover({
        transition: { status: 'idle' },
        activeTarget: ACTIVE,
        heldTarget: activated.heldTarget,
        localeActivationChanged: false,
        runActive: true,
      }),
      { visibleTarget: ACTIVE, heldTarget: ACTIVE },
    );
    assert.deepStrictEqual(
      resolveLocalizationCover({
        transition: { status: 'idle' },
        activeTarget: ACTIVE,
        heldTarget: activated.heldTarget,
        localeActivationChanged: false,
        runActive: false,
      }),
      { visibleTarget: null, heldTarget: null },
    );
  });

  it('reveals an activated locale immediately when no response is running', () => {
    assert.deepStrictEqual(
      resolveLocalizationCover({
        transition: { status: 'idle' },
        activeTarget: ACTIVE,
        heldTarget: null,
        localeActivationChanged: true,
        runActive: false,
      }),
      { visibleTarget: null, heldTarget: null },
    );
  });

  it('does not promote a same-locale pending cover into an ordinary response hold', () => {
    const pending = resolveLocalizationCover({
      transition: { status: 'pending', messageLocale: 'ru', formatLocale: 'ru' },
      activeTarget: ACTIVE,
      heldTarget: null,
      localeActivationChanged: false,
      runActive: true,
    });
    assert.deepStrictEqual(pending, {
      visibleTarget: { messageLocale: 'ru', formatLocale: 'ru' },
      heldTarget: null,
    });
    assert.deepStrictEqual(
      resolveLocalizationCover({
        transition: { status: 'idle' },
        activeTarget: ACTIVE,
        heldTarget: pending.heldTarget,
        localeActivationChanged: false,
        runActive: true,
      }),
      { visibleTarget: null, heldTarget: null },
    );
  });
});
