import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  agentRunPresentationForChannel,
  createAgentRunPresentationMiddlewares,
  DEFAULT_AGENT_RUN_PRESENTATION,
  SCREENLESS_AGENT_RUN_PRESENTATION,
} from './agent-run-presentation.ts';

describe('AgentRun presentation capability', () => {
  it('derives conservative screen context without removing record-backed surfaces', () => {
    assert.deepStrictEqual(agentRunPresentationForChannel('http'), {
      screenContext: 'absent',
      uiEffects: 'allowed',
    });
    assert.deepStrictEqual(agentRunPresentationForChannel('voice'), {
      screenContext: 'live',
      uiEffects: 'allowed',
    });
    assert.deepStrictEqual(agentRunPresentationForChannel(undefined), {
      screenContext: 'absent',
      uiEffects: 'allowed',
    });
  });

  it('installs current UI context only for an attachment with a live screen', () => {
    const live = createAgentRunPresentationMiddlewares({
      capability: DEFAULT_AGENT_RUN_PRESENTATION,
      stateTree: null,
      sessionKey: 'session-1',
      channel: 'voice',
    });
    const screenless = createAgentRunPresentationMiddlewares({
      capability: SCREENLESS_AGENT_RUN_PRESENTATION,
      stateTree: null,
      sessionKey: 'session-1',
      channel: 'voice',
    });

    assert.strictEqual(live.length, 2, 'UI state plus the channel situation');
    assert.strictEqual(screenless.length, 1, 'channel situation only');
  });

  it('keeps screen context separate from permission to create surface effects', () => {
    const rendererlessButSurfaceCapable = createAgentRunPresentationMiddlewares({
      capability: { screenContext: 'absent', uiEffects: 'allowed' },
      stateTree: null,
      channel: 'http',
    });

    assert.strictEqual(rendererlessButSurfaceCapable.length, 1);
  });
});
