import assert from 'node:assert';
import { describe, it } from 'node:test';
import { processPageKind } from './page-registry.ts';

describe('processPageKind', () => {
  it('serves the dedicated page when one is registered', () => {
    assert.strictEqual(processPageKind('DeepResearch'), 'dedicated');
  });

  it('serves the generic working card for any unregistered tool', () => {
    assert.strictEqual(processPageKind('web_search'), 'generic');
    assert.strictEqual(processPageKind('some_future_tool'), 'generic');
  });

  it('never covers a surface render with a process card', () => {
    assert.strictEqual(processPageKind('Surface'), 'none');
  });
});
