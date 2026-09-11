import { ToolModel } from '../../tools/tool-model.ts';
import type { ToolExecuteContext, ToolExecuteResult } from '../../tools/tool-model.ts';
import { z } from 'zod';

const anyInput = z.object({}).passthrough();

/** Visitor-audience UI fixture base — streaming component lifecycle with the
 *  componentName defaulting to the tool name (the shape the goldens were
 *  captured with). */
class UiFixtureTool extends ToolModel<Record<string, unknown>> {
  constructor(name: string, description: string) {
    super({
      toolType: 'function',
      name,
      description,
      parametersSchema: anyInput,
      isStreaming: true,
      audience: 'visitor',
    });
  }
  override getComponentName(): string {
    return this.name;
  }
}

/** Streaming UI tool: full component lifecycle with uiProps. */
export class WidgetTool extends UiFixtureTool {
  constructor() {
    super('Widget', 'fixture widget');
  }
  override async execute(
    input: Record<string, unknown>,
    _ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    return { output: `widget ok: ${JSON.stringify(input)}`, uiProps: { rendered: true, input } };
  }
}

/** UI tool whose execute throws → output-error path. */
export class FailingTool extends UiFixtureTool {
  constructor() {
    super('Failing', 'fixture failure');
  }
  override async execute(): Promise<ToolExecuteResult> {
    throw new Error('fixture-explosion');
  }
}

/** Pattern-A tool: returns output WITHOUT uiProps → terminal emit suppressed. */
export class SilentRetryTool extends UiFixtureTool {
  constructor() {
    super('SilentRetry', 'fixture pattern-A');
  }
  override async execute(): Promise<ToolExecuteResult> {
    return { output: 'retry with corrected input' };
  }
}

/** Non-UI tool (no componentName) → ToolContent observer path. */
export class PlainDataTool extends ToolModel<Record<string, unknown>> {
  constructor() {
    super({
      toolType: 'function',
      name: 'PlainData',
      description: 'fixture non-ui',
      parametersSchema: anyInput,
    });
  }
  override async execute(): Promise<ToolExecuteResult> {
    return { output: 'rows: 3', uiProps: { rows: 3 } };
  }
}

/** Blocking tool: returns status pending → markPendingToolCall. */
export class BlockingTool extends UiFixtureTool {
  constructor() {
    super('Blocking', 'fixture blocking');
  }
  override async execute(): Promise<ToolExecuteResult> {
    return { output: 'waiting for user', uiProps: { question: 'pick one' }, status: 'pending' };
  }
}

/** Emits a generic CUSTOM AG-UI event via ctx during execute — exercises the
 *  emit hook (zero A2UI knowledge; the event name/value are opaque). */
export class CustomEventTool extends UiFixtureTool {
  constructor() {
    super('CustomEvent', 'fixture custom-event emitter');
  }
  override async execute(
    _input: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    ctx.emitCustomEvent?.('x.test', { a: 1 });
    return { output: 'emitted', uiProps: { emitted: true } };
  }
}

/** Subagent-like tool: streams composite-id text + progress via ctx. */
export class StreamingChildTool extends UiFixtureTool {
  constructor() {
    super('Subagent', 'fixture subagent');
  }
  override async execute(
    _input: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    ctx.streamText?.({ type: 'text', text: 'child says hi', messageId: 'child-m1' });
    ctx.streamText?.({ type: 'reasoning', text: 'child thinks', messageId: 'child-r1' });
    ctx.onProgress?.({ status: 'working', toolCount: 1 });
    ctx.streamText?.({ type: 'text', text: ' and bye', messageId: 'child-m1' });
    return { output: 'child done', uiProps: { status: 'done', toolCount: 1 } };
  }
}
