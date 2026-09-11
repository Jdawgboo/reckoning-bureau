import type { AgentContent } from '../bl/agent/agent-library.ts';
import type { AgentSession } from './agent-session.ts';

export type VoiceContentEvent = Parameters<Parameters<AgentSession['subscribeContent']>[0]>[0];

export class VoiceContentHandoff {
  #pending: VoiceContentEvent[] = [];
  #liveHandler: ((content: VoiceContentEvent) => void) | null = null;

  observe = (content: VoiceContentEvent): void => {
    if (this.#liveHandler) {
      this.#liveHandler(content);
      return;
    }
    this.#pending.push(content);
  };

  pendingContent(): AgentContent[] {
    return this.#pending.filter(isAgentContent);
  }

  activate(
    snapshot: AgentContent[],
    liveHandler: (content: VoiceContentEvent) => void,
  ): VoiceContentEvent[] {
    if (this.#liveHandler) {
      throw new Error('voice content handoff is already active');
    }
    const snapshotMessageIds = new Set(snapshot.map((content) => content.messageId));
    this.#liveHandler = liveHandler;
    const pending = this.#pending;
    this.#pending = [];
    return pending.filter(
      (content) => !isAgentContent(content) || !snapshotMessageIds.has(content.messageId),
    );
  }
}

function isAgentContent(content: VoiceContentEvent): content is AgentContent {
  return content.type !== 'finish' && content.type !== 'error';
}
