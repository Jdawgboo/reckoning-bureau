import { test } from 'node:test';
import assert from 'node:assert';
import { formatRelativeAge } from './relative-age.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('59 seconds ago is "just now"', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 59_000, now), 'just now');
});

test('exactly 1 minute ago is singular', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - MINUTE, now), '1 minute ago');
});

test('59 minutes ago stays in the minutes bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 59 * MINUTE, now), '59 minutes ago');
});

test('90 minutes ago rolls into the hours bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 90 * MINUTE, now), '1 hour ago');
});

test('exactly 60 minutes ago is 1 hour, not 60 minutes', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 60 * MINUTE, now), '1 hour ago');
});

test('23 hours 59 minutes ago stays in the hours bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - (23 * HOUR + 59 * MINUTE), now), '23 hours ago');
});

test('exactly 24 hours ago rolls into the days bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 24 * HOUR, now), '1 day ago');
});

test('6 days ago stays in the days bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 6 * DAY, now), '6 days ago');
});

test('8 days ago rolls into the weeks bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 8 * DAY, now), '1 week ago');
});

test('exactly 7 days ago is 1 week, not 7 days', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 7 * DAY, now), '1 week ago');
});

test('29 days ago stays in the weeks bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 29 * DAY, now), '4 weeks ago');
});

test('exactly 30 days ago rolls into the months bucket', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 30 * DAY, now), '1 month ago');
});

test('90 days ago is 3 months', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 90 * DAY, now), '3 months ago');
});

test('a future timestamp (clock skew) clamps to "just now" instead of negative', () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now + 5 * MINUTE, now), 'just now');
});
