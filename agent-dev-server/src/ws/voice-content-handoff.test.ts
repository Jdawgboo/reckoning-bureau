import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createTextContent } from '../bl/agent/agent-library.ts';
import { VoiceContentHandoff, type VoiceContentEvent } from './voice-content-handoff.ts';

describe('VoiceContentHandoff', () => {
  it('switches atomically from buffering to the live handler', () => {
    const handoff = new VoiceContentHandoff();
    const before = createTextContent({ messageId: 'before', content: 'before' });
    const after = createTextContent({ messageId: 'after', content: 'after' });
    const live: VoiceContentEvent[] = [];

    handoff.observe(before);
    const buffered = handoff.activate([], (content) => live.push(content));
    handoff.observe(after);

    assert.deepStrictEqual(buffered, [before]);
    assert.deepStrictEqual(live, [after]);
  });

  it('drops buffered content already represented by the durable snapshot', () => {
    const handoff = new VoiceContentHandoff();
    const streamed = createTextContent({ messageId: 'same', content: 'streamed' });
    const persisted = createTextContent({ messageId: 'same', content: 'persisted' });
    const terminal: VoiceContentEvent = {
      type: 'finish',
      messageId: 'finish',
      responseId: 'run-1',
    };

    handoff.observe(streamed);
    handoff.observe(terminal);

    assert.deepStrictEqual(
      handoff.activate([persisted], () => {}),
      [terminal],
    );
  });

  it('exposes buffered content for history classification without terminal signals', () => {
    const handoff = new VoiceContentHandoff();
    const text = createTextContent({ messageId: 'text', content: 'hello' });
    handoff.observe({ type: 'finish', messageId: 'finish', responseId: 'run-1' });
    handoff.observe(text);

    assert.deepStrictEqual(handoff.pendingContent(), [text]);
  });
});
