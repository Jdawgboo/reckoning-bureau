import { describe, it } from 'node:test';
import assert from 'node:assert';
import { consumeContentStream } from './consume-content-stream.ts';
import { createTextContent, type AgentContent } from '../bl/agent/agent-library.ts';
import type { AgentSession } from '../ws/agent-session.ts';

function fakeSession(): {
  session: AgentSession;
  broadcasted: AgentContent[];
  pushed: AgentContent[];
} {
  const broadcasted: AgentContent[] = [];
  const pushed: AgentContent[] = [];
  const session = {
    sessionKey: 'sess-1',
    broadcastContent: (content: AgentContent) => {
      broadcasted.push(content);
    },
    pushContent: (content: AgentContent) => {
      pushed.push(content);
    },
  } as unknown as AgentSession;
  return { session, broadcasted, pushed };
}

async function* streamOf(contents: AgentContent[]): AsyncGenerator<AgentContent> {
  for (const content of contents) {
    yield content;
  }
}

describe('consumeContentStream', () => {
  it('stores content carrying the same responseId it broadcasts — seed replay groups stored history by responseId', async () => {
    const { session, broadcasted, pushed } = fakeSession();
    const content = createTextContent({ messageId: 'm1', content: 'hello' });

    await consumeContentStream(session, streamOf([content]), 'resp-42');

    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].responseId, 'resp-42');
    assert.strictEqual(broadcasted[0].responseId, 'resp-42');
  });

  it('does not mutate the content yielded by the stream', async () => {
    const { session } = fakeSession();
    const content = createTextContent({ messageId: 'm1', content: 'hello' });

    await consumeContentStream(session, streamOf([content]), 'resp-42');

    assert.strictEqual(content.responseId, undefined);
  });
});
