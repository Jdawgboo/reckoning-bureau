import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveErrorNotice } from './error-notice.ts';

const failed = { responseId: 'r1', message: 'Agent credits exhausted' };
const turnWithText = {
  responseId: 'r1',
  responseText:
    'This agent has run out of credits. Please contact the agent owner to restore service.',
};

test('no error means no notice', () => {
  assert.equal(
    resolveErrorNotice({ viewKind: 'surface', lastRunError: null, liveTurn: turnWithText }),
    null,
  );
});

test('a failed run over a rendered surface shows the terminal text', () => {
  assert.equal(
    resolveErrorNotice({ viewKind: 'surface', lastRunError: failed, liveTurn: turnWithText }),
    turnWithText.responseText,
  );
});

test('a failed run over a process page shows the terminal text', () => {
  assert.equal(
    resolveErrorNotice({ viewKind: 'process', lastRunError: failed, liveTurn: turnWithText }),
    turnWithText.responseText,
  );
});

test('falls back to the error message when the turn carries no text', () => {
  assert.equal(
    resolveErrorNotice({
      viewKind: 'surface',
      lastRunError: failed,
      liveTurn: { responseId: 'r1', responseText: '' },
    }),
    'Agent credits exhausted',
  );
});

test('text and loading views own their error display — no banner', () => {
  assert.equal(
    resolveErrorNotice({ viewKind: 'text', lastRunError: failed, liveTurn: turnWithText }),
    null,
  );
  assert.equal(
    resolveErrorNotice({ viewKind: 'loading', lastRunError: failed, liveTurn: turnWithText }),
    null,
  );
});

test('an error from an older run than the live turn is stale — no banner', () => {
  assert.equal(
    resolveErrorNotice({
      viewKind: 'surface',
      lastRunError: { responseId: 'r0', message: 'boom' },
      liveTurn: turnWithText,
    }),
    null,
  );
});
