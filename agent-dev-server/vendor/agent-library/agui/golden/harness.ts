import { AgentService } from '../../core/agent.service.ts';
import { ToolRegistry } from '../../tools/tool-registry.ts';
import type AgentState from '../../core/agent-state.ts';
import type { AgentContent } from '../../types/content.ts';
import type { UiSink } from '../../kernel/ui-sink.ts';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { TraceOrchestrator } from '../../telemetry/trace-orchestrator.ts';
import type { EventSink } from '../../types/event-stream.ts';
import type { AguiEvent } from '../events.ts';
import type { SessionType } from '../../sessions/types.ts';
import { FakeRunner, type ScriptStep } from './fake-runner.ts';
import {
  BlockingTool,
  CustomEventTool,
  FailingTool,
  PlainDataTool,
  SilentRetryTool,
  StreamingChildTool,
  WidgetTool,
} from './fixture-tools.ts';

export interface Scenario {
  script: ScriptStep[];
  /** End the ui sink after N appends to exercise the abort path. */
  endAfterAppends?: number;
}

export interface RunScenarioOpts {
  /** Observe the raw runner AgentStreamEvent stream. */
  eventSink?: EventSink;
  /** Observe the native AG-UI event stream. */
  aguiSink?: (ev: AguiEvent) => void;
  /** Session type for the run — drives the headless blocking policy. Defaults to 'web'. */
  sessionType?: SessionType;
}

interface StubCaptured {
  emitted: AgentContent[][];
  pendingToolCalls: string[];
}

/** Stub AgentState implementing exactly what AgentService.stream() touches. */
function createStubState(): AgentState & { __captured: StubCaptured } {
  const captured: StubCaptured = { emitted: [], pendingToolCalls: [] };
  const stub = {
    getResponseId: () => 'resp-1',
    emitContent: (items: AgentContent[]) => void captured.emitted.push(items),
    setStepMessages: () => {},
    getStepMessages: () => [],
    commitPendingStepInjections: () => {},
    commitStepMessages: () => {},
    getConversationHistory: () => [],
    getTraceConfig: () => undefined,
    getModelId: () => 'test-model',
    getProvider: () => 'test',
    getApp: () => null,
    getLastFinalPrompt: undefined,
    setTraceId: () => {},
    markPendingToolCall: (id: string) => void captured.pendingToolCalls.push(id),
    __captured: captured,
  };
  return stub as unknown as AgentState & { __captured: StubCaptured };
}

function capturingSink(endAfterAppends?: number): UiSink<AgentContent> & { items: AgentContent[] } {
  const items: AgentContent[] = [];
  let ended = false;
  return {
    items,
    isEnded: () => ended,
    append(content: AgentContent) {
      items.push(structuredClone(content));
      if (endAfterAppends !== undefined && items.length >= endAfterAppends) {
        ended = true;
      }
    },
    endStream() {
      ended = true;
    },
  };
}

/**
 * Normalize non-deterministic generated ids (generateShortId) to stable
 * placeholders by first appearance. Deterministic ids (script-provided
 * messageIds, toolCallIds, composite `${toolCallId}:${childId}`) are left
 * untouched so identity invariants stay asserted.
 */
export function normalizeIds(items: AgentContent[], knownIds: Set<string>): AgentContent[] {
  const map = new Map<string, string>();
  let counter = 0;
  return items.map((item) => {
    const id = item.messageId;
    if (knownIds.has(id) || [...knownIds].some((k) => id.startsWith(`${k}:`))) {
      return item;
    }
    if (!map.has(id)) {
      counter += 1;
      map.set(id, `gen-${counter}`);
    }
    return { ...item, messageId: map.get(id) as string };
  });
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOpts = {},
): Promise<{ contents: AgentContent[]; pendingToolCalls: string[] }> {
  const registry = new ToolRegistry();
  registry.registerTools([
    new WidgetTool(),
    new FailingTool(),
    new SilentRetryTool(),
    new PlainDataTool(),
    new BlockingTool(),
    new StreamingChildTool(),
    new CustomEventTool(),
  ]);

  const state = createStubState();
  const sink = capturingSink(scenario.endAfterAppends);
  const noopOrchestrator = { startRun: () => undefined } as unknown as TraceOrchestrator;
  const service = new AgentService({
    toolRegistry: registry,
    state,
    runner: new FakeRunner(scenario.script),
    traceOrchestrator: noopOrchestrator,
  });

  await service.stream({
    model: { modelId: 'test' } as unknown as LanguageModelV3,
    instructions: 'fixture',
    messages: [],
    ui: sink,
    eventSink: opts.eventSink,
    aguiSink: opts.aguiSink,
    sessionType: opts.sessionType,
  });

  const knownIds = new Set<string>();
  for (const step of scenario.script) {
    if (step.kind === 'execute') {
      knownIds.add(step.toolCallId);
      continue;
    }
    const ev = step.event as { messageId?: string; toolCallId?: string };
    if (typeof ev.messageId === 'string') {
      knownIds.add(ev.messageId);
    }
    if (typeof ev.toolCallId === 'string') {
      knownIds.add(ev.toolCallId);
    }
  }
  return {
    contents: normalizeIds(sink.items, knownIds),
    pendingToolCalls: state.__captured.pendingToolCalls,
  };
}
