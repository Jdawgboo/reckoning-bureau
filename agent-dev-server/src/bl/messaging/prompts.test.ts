import { test } from 'node:test';
import assert from 'node:assert';
import { createMemoryPrompt } from './prompts.ts';

const DAY = 24 * 60 * 60_000;

test('createMemoryPrompt returns an empty string for no memories', () => {
  assert.equal(createMemoryPrompt([], Date.now()), '');
});

test('createMemoryPrompt renders a relative-age prefix before each summary', () => {
  const now = 1_000_000_000;
  const text = createMemoryPrompt(
    [{ id: '1', summary: 'visitor is vegetarian', timestamp: now - 21 * DAY }],
    now,
  );
  assert.match(text, /- \(3 weeks ago\) visitor is vegetarian/);
});

test('createMemoryPrompt keeps only the newest 15 entries, oldest first', () => {
  const now = 1_000_000_000;
  const memories = Array.from({ length: 20 }, (_, i) => ({
    id: `${i}`,
    summary: `memory-${i}`,
    timestamp: now - (20 - i) * DAY,
  }));
  const text = createMemoryPrompt(memories, now);
  assert.doesNotMatch(text, /memory-4\b/);
  assert.match(text, /memory-5\b/);
  assert.match(text, /memory-19\b/);
});

test('createMemoryPrompt renders distinct ages for entries of different vintages', () => {
  const now = 1_000_000_000;
  const text = createMemoryPrompt(
    [
      { id: '1', summary: 'just chatted', timestamp: now - 30_000 },
      { id: '2', summary: 'old note', timestamp: now - 40 * DAY },
    ],
    now,
  );
  assert.match(text, /- \(just now\) just chatted/);
  assert.match(text, /- \(1 month ago\) old note/);
});
