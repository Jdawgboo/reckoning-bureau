import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createIntl, createIntlCache } from 'react-intl';
import {
  authoredNarration,
  formatNarrationLine,
  messageNarration,
  narrationMessageForTool,
} from './narration-line.ts';

test('classifies tools with locale-neutral narration keys', () => {
  assert.deepEqual(
    [
      'RenderServiceCatalog',
      'AppendLogEntry',
      'SendEmail',
      'FirecrawlSearch',
      'Grep',
      'UnknownTool',
    ].map(narrationMessageForTool),
    ['screenReady', 'savingDetails', 'passingAlong', 'lookingUp', 'checkingNotes', undefined],
  );
});

test('formats stable narration with the active locale bundle', () => {
  const intl = createIntl(
    {
      locale: 'ru',
      messages: {
        'common.thinking': 'Думаю…',
        'narration.screenReady': 'Готовим экран…',
      },
    },
    createIntlCache(),
  );

  assert.equal(formatNarrationLine(messageNarration('thinking'), intl), 'Думаю…');
  assert.equal(formatNarrationLine(messageNarration('screenReady'), intl), 'Готовим экран…');
});

test('formats structured research progress with ICU values', () => {
  const intl = createIntl(
    {
      locale: 'en',
      messages: {},
    },
    createIntlCache(),
  );

  assert.equal(
    formatNarrationLine(
      messageNarration('researching', {
        currentSearch: 'brake suppliers',
        searchCount: 3,
        sourceCount: 2,
      }),
      intl,
    ),
    'Researching: brake suppliers (3) · Sources: 2',
  );
});

test('preserves producer-authored progress text', () => {
  const intl = createIntl({ locale: 'ja', messages: {} }, createIntlCache());

  assert.equal(
    formatNarrationLine(authoredNarration('火曜日に3件の空きがあります'), intl),
    '火曜日に3件の空きがあります',
  );
});
