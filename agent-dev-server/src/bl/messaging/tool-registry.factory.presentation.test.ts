import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { ModelProvider } from '../agent/interfaces.ts';
import { MCPServerRegistry } from '../tools/mcp-server.registry.ts';
import { AgentStorageFactoryService } from '../../services/agent-storage-factory.service.ts';
import { SCREENLESS_AGENT_RUN_PRESENTATION } from './agent-run-presentation.ts';
import { ToolRegistryFactory } from './tool-registry.factory.ts';
import type { SessionLocaleRuntime } from './session-locale-runtime.ts';

const unusedModelProvider: ModelProvider = {
  getModel: async () => {
    throw new Error('model lookup is not used while assembling these tools');
  },
};

function dependencies() {
  return {
    storage: new AgentStorageFactoryService({
      apiBaseUrl: 'https://api.example.test',
      modelAccessToken: 'eyJhbGciOiJub25lIn0.eyJhZ2VudElkIjoiYWdlbnQtMSJ9.',
    }),
    mcp: new MCPServerRegistry({ loadEnabledServers: () => ({}) }),
  };
}

describe('ToolRegistryFactory listener grants', () => {
  it('lets the agent report progress only while someone is listening', async () => {
    const { storage, mcp } = dependencies();
    const spoken = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      { voiceActive: true },
    );
    const typed = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      { voiceActive: false },
    );

    assert.strictEqual(
      spoken.some((tool) => tool.getName() === 'report_progress'),
      true,
      'a waiting listener can be told what has been done so far',
    );
    assert.strictEqual(
      typed.some((tool) => tool.getName() === 'report_progress'),
      false,
      'on a screen the same work is already visible as it happens',
    );
  });

  it('grants it on a screenless spoken turn, where nothing else can be watched', async () => {
    const { storage, mcp } = dependencies();
    const tools = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      { voiceActive: true, runPresentation: SCREENLESS_AGENT_RUN_PRESENTATION },
    );

    assert.strictEqual(
      tools.some((tool) => tool.getName() === 'report_progress'),
      true,
    );
    assert.strictEqual(
      tools.some((tool) => tool.getName().startsWith('Render')),
      false,
      'speaking to the caller is not a UI effect',
    );
  });
});

describe('ToolRegistryFactory presentation grants', () => {
  it('removes every surface tool when UI effects are forbidden', async () => {
    const { storage, mcp } = dependencies();
    const tools = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      { runPresentation: SCREENLESS_AGENT_RUN_PRESENTATION },
    );

    assert.strictEqual(
      tools.some((tool) => tool.getName().startsWith('Render')),
      false,
    );
    assert.strictEqual(
      tools.some((tool) => tool.getName() === 'playVoiceAssistance'),
      false,
    );
    assert.strictEqual(
      tools.some((tool) => tool.getName() === 'persistToMemoryBank'),
      false,
    );
  });

  it('preserves markdown-backed surfaces for a renderer-less but UI-capable run', async () => {
    const { storage, mcp } = dependencies();
    const tools = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      {
        runPresentation: { screenContext: 'absent', uiEffects: 'allowed' },
      },
    );

    assert.strictEqual(
      tools.some((tool) => tool.getName().startsWith('Render')),
      true,
    );
    assert.strictEqual(
      tools.some((tool) => tool.getName() === 'playVoiceAssistance'),
      true,
    );
    assert.strictEqual(
      tools.some((tool) => tool.getName() === 'persistToMemoryBank'),
      true,
    );
  });
});

describe('ToolRegistryFactory locale grants', () => {
  it('grants the typed locale proposal tool only with a session locale authority', async () => {
    const { storage, mcp } = dependencies();
    const runtime: SessionLocaleRuntime = {
      current: () => ({
        messageLocale: 'en',
        formatLocale: 'en',
        source: 'default',
        revision: 0,
      }),
      propose: async () => ({
        messageLocale: 'fr',
        formatLocale: 'fr',
        source: 'explicit',
        revision: 1,
      }),
      stableUi: () => ({ status: 'no-browser', attachmentCount: 0 }),
      format: (messageId) => messageId,
    };
    const withAuthority = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
      undefined,
      'session-1',
      undefined,
      undefined,
      { sessionLocale: runtime },
    );
    const withoutAuthority = await ToolRegistryFactory.createPlatformTools(
      'test-model',
      unusedModelProvider,
      storage,
      mcp,
    );

    assert.strictEqual(
      withAuthority.some((tool) => tool.getName() === 'SetSessionLocale'),
      true,
    );
    assert.strictEqual(
      withoutAuthority.some((tool) => tool.getName() === 'SetSessionLocale'),
      false,
    );
  });
});
