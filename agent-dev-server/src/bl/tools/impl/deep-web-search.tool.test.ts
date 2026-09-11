import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deepWebSearchParamsSchema } from './deep-web-search.schema.ts';

// See `web-search-fallback.tool.test.ts` for why forwarding is not unit-tested
// from this file. Schema validation is the load-bearing part; the conditional
// in `execute()` is a two-line forward verified by typecheck and code review.

describe('deepWebSearchParamsSchema', () => {
  it('accepts query alone', () => {
    const result = deepWebSearchParamsSchema.safeParse({ query: 'hello' });
    assert.equal(result.success, true);
  });

  it('accepts paired start_time + end_time with valid ordering', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00Z',
      end_time: '2026-05-19T00:00:00Z',
    });
    assert.equal(result.success, true);
  });

  it('rejects when only start_time is provided', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0].message, /both or neither/);
    }
  });

  it('rejects when only end_time is provided', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      end_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects when end_time is before start_time', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-19T00:00:00Z',
      end_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects when end_time equals start_time', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-19T00:00:00Z',
      end_time: '2026-05-19T00:00:00Z',
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0].message, /strictly after/);
    }
  });

  it('rejects datetime without timezone offset', () => {
    const result = deepWebSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00',
      end_time: '2026-05-19T00:00:00',
    });
    assert.equal(result.success, false);
  });
});
