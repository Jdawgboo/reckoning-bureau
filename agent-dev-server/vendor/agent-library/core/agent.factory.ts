import Agent from './agent.ts';
import AgentState from './agent-state.ts';
import type { CreateAgent } from './create-agent.ts';
import type { CreateAgentParams } from './interfaces.ts';
import type { AgentRunner } from '../runners/agent-runner.ts';
import type { KernelPresenter } from '../kernel/presenter.ts';
import type { RetryPolicy, StopPolicy, TurnPolicy } from '../kernel/policies.ts';
import type { AgentRunOutcome } from './agent.service.ts';
import type { TraceOrchestrator } from '../telemetry/trace-orchestrator.ts';
import type { AgentParamsT } from './agent.ts';

type AgentFactoryDeps = {
  runner: AgentRunner;
  presenter: KernelPresenter;
  policies: {
    stop: StopPolicy;
    retry: RetryPolicy;
    turn: TurnPolicy;
  };
  onComplete?: (args: { state: AgentState; outcome: AgentRunOutcome }) => void | Promise<void>;
  traceOrchestrator?: TraceOrchestrator;
  resolveUserMessage?: AgentParamsT['resolveUserMessage'];
};

/**
 * Composition-root friendly factory.
 *
 * Keeps DI clean (instantiate a class) while still allowing call-sites that expect `CreateAgent`
 * (a plain function) to work via `.createAgent`.
 */
export class AgentFactory {
  private deps: AgentFactoryDeps;
  constructor(deps: AgentFactoryDeps) {
    this.deps = deps;
  }

  create(params: CreateAgentParams): Agent {
    const {
      state: stateRequest,
      traceName,
      systemInstruction,
      sessionManager,
      ...agentParams
    } = params;
    let state: AgentState;
    if (stateRequest instanceof AgentState) {
      state = stateRequest;
    } else if (stateRequest) {
      state = AgentState.createTurn(stateRequest);
    } else {
      state = AgentState.createTurn({ kernel: { conversationHistory: [] } });
    }

    return new Agent({
      ...agentParams,
      systemInstruction,
      state,
      traceName,
      runner: this.deps.runner,
      presenter: this.deps.presenter,
      policies: this.deps.policies,
      onComplete: this.deps.onComplete,
      traceOrchestrator: this.deps.traceOrchestrator,
      resolveUserMessage: agentParams.resolveUserMessage ?? this.deps.resolveUserMessage,
      sessionManager,
    });
  }

  /**
   * Bound function form for code that expects `CreateAgent`.
   */
  get createAgent(): CreateAgent {
    return this.create.bind(this);
  }
}
