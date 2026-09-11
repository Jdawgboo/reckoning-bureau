import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildDeployedGrounding,
  hasVoiceConversationHistory,
  memoryBankSection,
} from './voice-narration.ts';
import { createTextContent } from '../bl/agent/agent-library.ts';

describe('buildDeployedGrounding', () => {
  it('reports hasHistory without projecting identity or conversation into grounding', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: true,
    });
    assert.strictEqual(grounding.hasHistory, true);
    assert.doesNotMatch(grounding.text, /cfg-internal-123|Glow Salon|You ARE/);
    assert.doesNotMatch(grounding.text, /what are your hours/);
    assert.doesNotMatch(grounding.text, /We open at nine/);
  });

  it('fresh sessions have no history', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
    });
    assert.strictEqual(grounding.hasHistory, false);
  });

  it('never includes a visitor profile section', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
    });
    assert.doesNotMatch(grounding.text, /Who the visitor is/);
  });

  it('renders one capability card line per entry, component — purpose', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
      capabilities: [
        { component: 'Table', purpose: 'Shows rows and columns of data.' },
        { component: 'Form', purpose: 'Collects typed details from the visitor.' },
      ],
    });
    assert.match(grounding.text, /ON-SCREEN CAPABILITIES/);
    assert.match(grounding.text, /- Table — Shows rows and columns of data\./);
    assert.match(grounding.text, /- Form — Collects typed details from the visitor\./);
  });

  it('omits the capability card section when capabilities is empty', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
      capabilities: [],
    });
    assert.doesNotMatch(grounding.text, /ON-SCREEN CAPABILITIES/);
  });

  it('omits the capability card section when capabilities is not supplied', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
    });
    assert.doesNotMatch(grounding.text, /ON-SCREEN CAPABILITIES/);
  });

  it('trims an oversized capability purpose to about 100 characters', async () => {
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
      capabilities: [{ component: 'Table', purpose: 'z'.repeat(400) }],
    });
    const purposeRun = grounding.text.match(/z+/)?.[0] ?? '';
    assert.ok(purposeRun.length <= 100);
  });

  it('includes the memory section when memories are supplied', async () => {
    const now = 1_000_000_000;
    const grounding = await buildDeployedGrounding({
      hasHistory: false,
      memories: [{ id: '1', summary: 'User has a dog named Max', timestamp: now }],
      now,
    });
    assert.match(grounding.text, /What the visitor has told you before/);
    assert.match(grounding.text, /- \(just now\) User has a dog named Max/);
  });

  it('omits the memory section when memories is empty or not supplied', async () => {
    const empty = await buildDeployedGrounding({
      hasHistory: false,
      memories: [],
    });
    assert.doesNotMatch(empty.text, /What the visitor has told you before/);

    const absent = await buildDeployedGrounding({
      hasHistory: false,
    });
    assert.doesNotMatch(absent.text, /What the visitor has told you before/);
  });
});

describe('hasVoiceConversationHistory', () => {
  it('recognizes visible durable conversation text', () => {
    assert.strictEqual(
      hasVoiceConversationHistory(
        [
          createTextContent({
            messageId: 'visible',
            content: 'What are your hours?',
            role: 'user',
          }),
        ],
        'voice',
      ),
      true,
    );
  });

  it('recognizes hidden voice conversation that the visitor already heard', () => {
    assert.strictEqual(
      hasVoiceConversationHistory(
        [
          createTextContent({
            messageId: 'spoken',
            content: 'I am open until six.',
            hidden: true,
            channel: 'voice',
          }),
        ],
        'voice',
      ),
      true,
    );
  });

  it('ignores hidden internal text, reasoning, and empty content', () => {
    assert.strictEqual(
      hasVoiceConversationHistory(
        [
          createTextContent({ messageId: 'hidden', content: 'internal', hidden: true }),
          createTextContent({ messageId: 'reasoning', content: 'thinking', isReasoning: true }),
          createTextContent({ messageId: 'empty', content: '   ' }),
        ],
        'voice',
      ),
      false,
    );
  });
});

describe('memoryBankSection', () => {
  const now = 1_000_000_000;
  const DAY = 24 * 60 * 60_000;

  it('returns an empty string for no memories', () => {
    assert.strictEqual(memoryBankSection([], now), '');
  });

  it('renders one line per memory, prefixed with its relative age', () => {
    const section = memoryBankSection(
      [
        { id: '1', summary: 'Likes trail running', timestamp: now },
        { id: '2', summary: 'Has a dog named Max', timestamp: now - 8 * DAY },
      ],
      now,
    );
    assert.match(section, /^What the visitor has told you before/);
    assert.match(section, /- \(just now\) Likes trail running/);
    assert.match(section, /- \(1 week ago\) Has a dog named Max/);
  });

  it('keeps only the newest 15 entries', () => {
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `${i}`,
      summary: `memory-${i}`,
      timestamp: now - (20 - i) * DAY,
    }));
    const section = memoryBankSection(memories, now);
    assert.doesNotMatch(section, /memory-4\n/);
    assert.match(section, /memory-5/);
    assert.match(section, /memory-19/);
    assert.strictEqual(section.split('\n').length - 1, 15);
  });

  it('trims an oversized entry to about 200 characters', () => {
    const section = memoryBankSection([{ id: '1', summary: 'x'.repeat(500), timestamp: now }], now);
    const run = section.match(/x+/)?.[0] ?? '';
    assert.ok(run.length <= 200);
  });

  it('defaults `now` to the current clock when omitted', () => {
    const section = memoryBankSection([{ id: '1', summary: 'fresh note', timestamp: Date.now() }]);
    assert.match(section, /- \(just now\) fresh note/);
  });
});
