import { createTextContent, createComponent, type AgentContent } from '../types/content.ts';
import { generateShortId } from '../types/id.ts';
import type { LlmErrorCode } from '../types/errors.ts';
import type AgentState from '../core/agent-state.ts';
import type { KernelPresenter } from '../kernel/presenter.ts';
import type { UiSink } from '../kernel/ui-sink.ts';

/**
 * Default presenter implementation for the agent runtime library.
 * Delegates UI emission responsibilities without coupling to application state.
 */
export class DefaultPresenter implements KernelPresenter {
  emitComponent(params: {
    sink: UiSink;
    state: AgentState;
    componentName: string;
    props: Record<string, unknown>;
  }): void {
    params.sink.append(
      createComponent({
        messageId: generateShortId(8),
        responseId: params.state.getResponseId(),
        componentName: params.componentName,
        props: params.props,
      }),
    );
  }

  emitExecutionLimit(params: {
    sink: UiSink;
    state: AgentState;
    maxExecutions: number;
  }): AgentContent {
    const content = createComponent({
      messageId: generateShortId(8),
      responseId: params.state.getResponseId(),
      componentName: 'OneIterationExecutionLimit',
      props: { maxExecutions: params.maxExecutions },
    });
    params.sink.append(content);
    return content;
  }

  emitTerminalMessage(params: {
    sink: UiSink;
    state: AgentState;
    message: string;
    errorCode?: LlmErrorCode;
  }): AgentContent {
    const content = createTextContent({
      messageId: generateShortId(8),
      responseId: params.state.getResponseId(),
      content: params.message,
      errorCode: params.errorCode,
    });
    params.sink.append(content);
    params.state.emitContent([content]);
    return content;
  }
}
