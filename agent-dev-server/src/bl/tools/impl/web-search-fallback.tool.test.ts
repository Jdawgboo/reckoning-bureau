import { describe, it } from 'node:test';
import assert from 'node:assert';
import { webSearchParamsSchema } from './web-search-fallback.schema.ts';

// Forwarding behaviour (the conditional that turns start_time/end_time into a
// `timeRangeFilter` and passes it into `provider.tools.googleSearch(...)`) is
// not unit-tested here: the tool file transitively imports from
// `../../agent/agent-library`, which uses extensionless module specifiers
// throughout. Node's native test runner refuses to resolve those without a
// build step, so the forwarding code is left to typecheck plus code review.
// The conditional itself is two lines; schema validation (below) is the
// behaviour worth locking in.

describe('webSearchParamsSchema', () => {
  it('accepts query alone', () => {
    const result = webSearchParamsSchema.safeParse({ query: 'hello' });
    assert.equal(result.success, true);
  });

  it('accepts paired start_time + end_time with valid ordering', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00Z',
      end_time: '2026-05-19T00:00:00Z',
    });
    assert.equal(result.success, true);
  });

  it('rejects when only start_time is provided', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0].message, /both or neither/);
    }
  });

  it('rejects when only end_time is provided', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      end_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects when end_time equals start_time', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-19T00:00:00Z',
      end_time: '2026-05-19T00:00:00Z',
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0].message, /strictly after/);
    }
  });

  it('rejects when end_time is before start_time', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-19T00:00:00Z',
      end_time: '2026-05-12T00:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects datetime without timezone offset', () => {
    const result = webSearchParamsSchema.safeParse({
      query: 'hello',
      start_time: '2026-05-12T00:00:00',
      end_time: '2026-05-19T00:00:00',
    });
    assert.equal(result.success, false);
  });
});
