/** Turns raw agui events into locale-neutral stage narration state. */
import { makeAutoObservable } from 'mobx';
import type { AguiEvent } from '@/lib/agent-library';
import {
  ContentType,
  type AgentContent,
  type ComponentContent,
} from '../../../../vendor/agent-library/types/content.ts';
import { PROCESS_NARRATIONS } from './process/narration.ts';
import {
  authoredNarration,
  messageNarration,
  narrationMessageForTool,
  type NarrationLine,
} from './narration-line.ts';

export class NarrationStore {
  line: NarrationLine | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  handle(event: AguiEvent): void {
    if (event.type === 'RUN_STARTED') {
      this.line = messageNarration('thinking');
      return;
    }
    if (event.type === 'TOOL_CALL_START') {
      this.line = messageNarration(narrationMessageForTool(event.toolCallName) ?? 'thinking');
      return;
    }
    if (event.type === 'TOOL_CALL_END') {
      const toolName = event.x?.toolName;
      if (toolName) {
        const message = narrationMessageForTool(toolName);
        if (message) {
          this.line = messageNarration(message);
        }
      }
      return;
    }
    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      this.line = null;
    }
  }

  /** Live progress for a tool part. A producer-authored progress fact
   *  (`content.progress`) wins — the same fact the voice channel speaks —
   *  then the component's process narration while it is still executing. */
  handleToolPart(content: AgentContent): void {
    const fact = content.progress?.text.trim();
    if (fact) {
      this.line = authoredNarration(fact);
      return;
    }
    if (content.type !== ContentType.Component) {
      return;
    }
    const part = content as ComponentContent;
    const state = part.streaming?.state;
    if (state !== 'input-streaming' && state !== 'input-available' && state !== 'output-pending') {
      return;
    }
    const narrate = PROCESS_NARRATIONS[part.componentName];
    if (narrate) {
      this.line = narrate(part.props);
    }
  }
}
