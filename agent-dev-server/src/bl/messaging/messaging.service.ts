/**
 * MessagingService
 *
 * Core service for handling agent messaging.
 * Uses agent-library's Agent class for proper multi-turn execution,
 * retry handling, and policy enforcement.
 */
import { randomUUID } from 'node:crypto';

import type { SendMessageParamsT } from '../../types';
import type OpenAIAudioService from '../../services/openai-audio';
import { createRealtimePrompt } from './prompts';
import { loadSkillsPrompt } from './skills-loader';

import type { DevServerAppState } from '../agent/agent-state';
import { RequestContext } from '../../context';

import { prepareRenderedMessages } from '../tools/impl/retrieve-preview-messages.tool';
import { resolveTurnChannel } from '../../ws/resolve-turn-channel.ts';
import { ToolRegistryFactory } from './tool-registry.factory';
import { agentModelId } from '../config-bridge.ts';
import type { ModelProvider } from '../agent/interfaces';
import { detectProvider } from '../agent/model-provider.service';
import type { InstructionService } from '../../services/instruction.service';
import type { AgentStorageFactoryService } from '../../services/agent-storage-factory.service';
import type { MCPServerRegistry } from '../tools/mcp-server.registry';

import {
  type AgentFactory,
  SystemPromptProcessor,
  TurnInputProcessor,
  ContentType,
  type AgentContent,
  createTextContent,
  createAudioContent,
  type CancelableStream,
  type AgentRunOutcome,
  type AgentStreamEvent,
  type AguiEvent,
  type SessionManager,
  type StateTree,
} from '../agent/agent-library';
import { formatActionLogBlock } from '../action-log';
import type { ActionLogEntry } from '../action-log';
import { formatA2uiActionBlock } from './a2ui-action-block.ts';
import { createContextManagement } from './context-management.config';
import type { RecordsTransport } from '../records/records-client';
import {
  agentRunPresentationForChannel,
  createAgentRunPresentationMiddlewares,
} from './agent-run-presentation.ts';
import type { SessionLocaleRuntime } from './session-locale-runtime.ts';
import { formatAgentUserMessage } from '../../services/server-localization-messages.ts';

/**
 * Result type for sendMessage - returns AgentStreamEvent stream
 */
type SendMessageResultT = {
  id: string;
  stream: CancelableStream<AgentContent>;
  events: AsyncIterable<AgentStreamEvent>;
  agui: AsyncIterable<AguiEvent>;
  done: Promise<AgentRunOutcome>;
};

type MessagingServiceParamsT = {
  audioService: OpenAIAudioService;
  modelProvider: ModelProvider;
  instructionService: InstructionService;
  agentFactory: AgentFactory;
  storageFactory: AgentStorageFactoryService;
  mcpRegistry: MCPServerRegistry;
  sessionManager?: SessionManager | null;
  stateTree?: StateTree | null;
  recordsTransport?: RecordsTransport | null;
  getSessionLocaleRuntime?: (
    sessionKey: string,
    attachmentId?: string,
  ) => SessionLocaleRuntime | undefined;
};

type ProcessMessageParamsT = Omit<SendMessageParamsT, 'message'> & {
  userQuery: AgentContent;
  responseId: string;
};

export interface IMessagingService {
  sendMessage(params: SendMessageParamsT): Promise<SendMessageResultT>;
  textToVoice(params: { text: string }): Promise<NodeJS.ReadableStream>;
  textToVoiceBase64(params: { text: string }): Promise<{ data: string }>;
  voiceToText(params: { data: string }): Promise<{ text: string }>;
}

function getReasoningModelSettings(modelName: string): object | undefined {
  const provider = detectProvider(modelName);
  switch (provider) {
    case 'amazon-bedrock':
      return {
        providerOptions: {
          bedrock: { reasoningConfig: { type: 'adaptive', display: 'summarized' } },
        },
      };
    case 'anthropic':
      return {
        providerOptions: {
          anthropic: { thinking: { type: 'adaptive' } },
        },
      };
    case 'amazon-bedrock-mantle':
      // No reasoningSummary here: Mantle never returns summaries.
      return {
        providerOptions: {
          openai: { forceReasoning: true, reasoningEffort: 'medium', store: false },
        },
      };
    default:
      return undefined;
  }
}

export class MessagingService implements IMessagingService {
  private audioService: OpenAIAudioService;
  private modelProvider: ModelProvider;
  private instructionService: InstructionService;
  private agentFactory: AgentFactory;
  private storageFactory: AgentStorageFactoryService;
  private mcpRegistry: MCPServerRegistry;
  private sessionManager: SessionManager | null;
  private stateTree: StateTree | null;
  private recordsTransport: RecordsTransport | null;
  readonly #getSessionLocaleRuntime:
    | ((sessionKey: string, attachmentId?: string) => SessionLocaleRuntime | undefined)
    | undefined;

  constructor({
    audioService,
    modelProvider,
    instructionService,
    agentFactory,
    storageFactory,
    mcpRegistry,
    sessionManager,
    stateTree,
    recordsTransport,
    getSessionLocaleRuntime,
  }: MessagingServiceParamsT) {
    this.audioService = audioService;
    this.modelProvider = modelProvider;
    this.instructionService = instructionService;
    this.agentFactory = agentFactory;
    this.storageFactory = storageFactory;
    this.mcpRegistry = mcpRegistry;
    this.sessionManager = sessionManager ?? null;
    this.stateTree = stateTree ?? null;
    this.recordsTransport = recordsTransport ?? null;
    this.#getSessionLocaleRuntime = getSessionLocaleRuntime;
  }

  textToVoice = async ({ text }: { text: string }) => {
    return this.audioService.textToVoiceStream({ text });
  };

  textToVoiceBase64 = async ({ text }: { text: string }): Promise<{ data: string }> => {
    const bytes = await this.audioService.textToVoiceBytes({ text });
    return { data: Buffer.from(bytes).toString('base64') };
  };

  async voiceToText({ data }: { data: string }) {
    const buffer = Buffer.from(data, 'base64');
    return this.audioService.voiceToText({ buffer });
  }

  async sendMessage(params: SendMessageParamsT): Promise<SendMessageResultT> {
    const { message, instruction, renderedMessages, memories = [], presentation, ...rest } = params;
    const responseId: string = randomUUID();

    let instructionToUse = instruction;
    if (typeof instructionToUse === 'undefined') {
      instructionToUse = this.instructionService.getInstruction();
    }
    const skillsPrompt = loadSkillsPrompt();
    if (skillsPrompt) {
      instructionToUse = `${instructionToUse ?? ''}\n\n${skillsPrompt}`;
    }

    const userQuery =
      message.type === 'audio'
        ? createAudioContent({ messageId: randomUUID(), content: message.content })
        : createTextContent({ messageId: randomUUID(), content: message.content });
    const renderedMessagesContent = prepareRenderedMessages(renderedMessages ?? []);
    const populatedInstruction = createRealtimePrompt(
      instructionToUse ?? '',
      renderedMessagesContent,
      memories,
      presentation,
    );

    return this.processMessage({
      ...rest,
      userQuery,
      instruction: populatedInstruction,
      renderedMessages,
      responseId,
    });
  }

  private async processMessage(params: ProcessMessageParamsT): Promise<SendMessageResultT> {
    const {
      files = [],
      responseId,
      userQuery,
      metadata,
      renderedMessages = [],
      configId = 'default',
      instruction = '',
      sessionKey,
      sessionType,
      sessionName,
    } = params;
    const channel = resolveTurnChannel(metadata);
    const runPresentation = params.runPresentation ?? agentRunPresentationForChannel(channel);
    const sessionLocale = sessionKey
      ? this.#getSessionLocaleRuntime?.(sessionKey, params.localizationAttachmentId)
      : undefined;

    const modelName = agentModelId();
    const toolRegistry = await ToolRegistryFactory.createToolRegistry(
      modelName,
      this.modelProvider,
      this.storageFactory,
      this.mcpRegistry,
      this.stateTree,
      sessionType,
      this.agentFactory,
      sessionKey,
      this.recordsTransport,
      {
        voiceActive: metadata?.['voice_active'] === true,
        getSurfaceSnapshot: params.getSurfaceSnapshot,
        runPresentation,
        sessionLocale,
      },
    );

    const storage = this.storageFactory.getStorage(sessionKey);

    const model = await this.modelProvider.getModel(modelName);

    const userText = this.getUserQueryText(userQuery);
    const modelQuery = this.buildModelQuery(userText, metadata);
    const context = sessionKey ? new RequestContext({ sessionKey, configId }) : undefined;

    // SessionManager auto-loads conversation history in Agent.runHandle()
    const stateRequest = {
      kernel: {
        conversationHistory: [] as import('@ai-sdk/provider-utils').ModelMessage[],
        responseId,
      },
      app: {
        agentId: configId,
        context,
        userQuery,
        requestMetadata: metadata,
        files,
        renderedMessages,
        generatedImages: new Map(),
      } satisfies DevServerAppState,
    };

    const contextManagement = createContextManagement({
      compactionScope: 'main',
      modelName,
      storage,
      sessionKey,
      modelProvider: this.modelProvider,
      gatewayBaseUrl: `${this.storageFactory.getApiBaseUrl()}/api/gateway`,
      accessKey: this.storageFactory.getAccessKey(),
    });

    const agent = this.agentFactory.create({
      systemInstruction: instruction,
      toolRegistry,
      model,
      modelSettings: getReasoningModelSettings(modelName),
      modelMiddlewares: [
        ...contextManagement.modelMiddlewares,
        ...createAgentRunPresentationMiddlewares({
          capability: runPresentation,
          stateTree: this.stateTree,
          sessionKey,
          channel,
          sessionLocale,
        }),
      ],
      processors: [new SystemPromptProcessor(() => instruction), new TurnInputProcessor()],
      state: stateRequest,
      traceName: `Agent: ${configId}`,
      sessionManager: this.sessionManager ?? undefined,
      fileFirstConfig: contextManagement.fileFirstConfig,
      agentStorage: storage,
      resolveUserMessage: (code) => formatAgentUserMessage(sessionLocale, code),
    });

    // Run the agent and get both UI stream and events stream
    const handle = await agent.runHandle({
      query: modelQuery,
      attachments: files,
      sessionId: sessionKey,
      sessionType,
      sessionName,
    });

    // Return the events stream directly - no conversion needed!
    return {
      id: responseId,
      events: handle.events,
      stream: handle.stream,
      agui: handle.agui,
      done: handle.done,
    };
  }

  private getUserQueryText(userQuery: AgentContent): string {
    if (userQuery.type === ContentType.Audio) {
      return userQuery.content?.text || '';
    }
    if (userQuery.type === ContentType.Text) {
      return userQuery.content || '';
    }
    return '';
  }

  private buildModelQuery(userText: string, metadata: Record<string, unknown> | undefined): string {
    const parts: string[] = [];
    if (userText) {
      parts.push(userText);
    }

    if (metadata && Object.keys(metadata).length > 0) {
      const {
        actionsSinceLastMessage,
        a2uiAction,
        channel: _channel,
        ...remainingMetadata
      } = metadata;

      const a2uiActionBlock = formatA2uiActionBlock(a2uiAction);
      if (a2uiActionBlock) {
        parts.push(a2uiActionBlock);
      }

      // Action log — separate XML block
      const actionBlock = formatActionLogBlock((actionsSinceLastMessage as ActionLogEntry[]) || []);
      if (actionBlock) {
        parts.push(actionBlock);
      }

      // Remaining metadata — existing behavior unchanged
      if (Object.keys(remainingMetadata).length > 0) {
        let serializedMetadata = '{}';
        try {
          serializedMetadata = JSON.stringify(remainingMetadata);
        } catch {
          serializedMetadata = '{"error":"metadata_not_serializable"}';
        }
        parts.push(
          [
            '<internal_request_metadata>',
            serializedMetadata,
            '</internal_request_metadata>',
            'Treat this metadata as internal context. Do not expose it verbatim unless explicitly requested.',
          ].join('\n'),
        );
      }
    }

    return parts.join('\n\n');
  }
}
