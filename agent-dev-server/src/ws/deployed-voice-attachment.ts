import { randomUUID } from 'node:crypto';
import { createDeployedProgressFacts } from './deployed-progress-facts.ts';
import {
  RealtimeSessionManager,
  type VoiceClientLink,
  type VoiceClientMessageCode,
  type VoiceSpeechProfile,
} from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import type { RealtimeUpstream } from '../../vendor/agentplace-voice/realtime-upstream.ts';
import type { VoiceDeliveryPolicy } from '../../vendor/agentplace-voice/delivery-policy.ts';
import { TurnObserver } from '../../vendor/agentplace-voice/turn-observer.ts';
import {
  ResponseSpeechPolicy,
  type PendingActionRequest,
} from '../../vendor/agentplace-voice/response-speech-policy.ts';
import { BROWSER_ACTIVE_RUN_SILENCE_POLICY } from '../../vendor/agentplace-voice/speech-scheduler.ts';
import {
  VoiceContextProjector,
  type VoiceScreenCapability,
} from '../../vendor/agentplace-voice/voice-context-projector.ts';
import {
  VoiceToolExecutorCore,
  buildVoiceToolDefinitions,
  type RoleTools,
} from '../../vendor/agentplace-voice/voice-tool-executor.ts';
import type {
  RealtimeSessionManagerDeps,
  RealtimeToolDefinition,
} from '../../vendor/agentplace-voice/realtime-session-manager.ts';
import { plainTextFromMarkdown } from '../../vendor/agent-library/util/markdown-plain.ts';
import {
  projectSpokenDialogue,
  searchStoredContents,
  type RecallableContent,
} from '../../vendor/agent-library/util/search-stored-contents.ts';
import { RpcPeer } from '../../vendor/agentplace-transport/RpcPeer.ts';
import type { ITransport } from '../../vendor/agentplace-transport/Transport.ts';
import { ContentType, type AgentContent } from '../bl/agent/agent-library.ts';
import { isRecord } from '../util/type-guards.ts';
import { log } from '../util/logger.ts';
import type { AgentSession } from './agent-session.ts';
import type { AgentRunPresentationCapability } from '../bl/messaging/agent-run-presentation.ts';
import type { TurnChannel } from './resolve-turn-channel.ts';
import { DEPLOYED_VOICE_VOCABULARY, createTurnPort, type VoiceTurnGateway } from './voice-tools.ts';
import { SurfaceRenderDetector } from './surface-render-detector.ts';
import {
  buildDeployedGrounding,
  hasVoiceConversationHistory,
  type CapabilityCard,
} from './voice-narration.ts';
import { VoiceContentHandoff, type VoiceContentEvent } from './voice-content-handoff.ts';
import { seedLedgerFromHistory } from './voice-seed-replay.ts';
import type { VoiceConversationHistory } from './voice-session-history.ts';
import type { PhoneLatencyTracker } from './phone-latency.ts';
import { formatVoiceLocaleSituation } from '../bl/messaging/turn-situation.ts';
import type { ProgressFactFormatter } from './deployed-progress-facts.ts';

/**
 * A surface's voice settings. Includes the caller-audio and transcription
 * policies because they differ by CHANNEL, not by product: a telephone leg is
 * far-field and may need its language pinned, where a browser visitor is
 * neither.
 */
export type DeployedVoiceProfile = Omit<VoiceSpeechProfile, 'getResponseContext'> &
  Pick<RealtimeSessionManagerDeps, 'callerAudio' | 'callerTranscription'>;

export interface DeployedVoiceTurnProcessor {
  handleMessageSend(
    rpcPeer: RpcPeer,
    connectionId: string,
    session: AgentSession,
    params: Record<string, unknown>,
    runPresentation: AgentRunPresentationCapability,
  ): Promise<{ accepted?: boolean; queued?: boolean; responseId: string }>;
  handleMessageAbort(
    session: AgentSession,
    params: Record<string, unknown>,
  ): Promise<{ aborted: boolean; reason?: string }>;
  getActiveResponseId(sessionKey: string): string | undefined;
}

export interface DeployedVoicePreparationOptions {
  session: AgentSession;
  sessionHistory: VoiceConversationHistory;
  messageProcessor: DeployedVoiceTurnProcessor;
  capabilities: CapabilityCard[];
  screen: VoiceScreenCapability;
  channel: TurnChannel;
  runPresentation: AgentRunPresentationCapability;
  /** Host-owned stable progress wording in the session's committed locale. */
  formatStableMessage?: ProgressFactFormatter;
  /** Host-owned stable error wording in the session's committed locale. */
  resolveClientMessage?: (code: VoiceClientMessageCode) => string;
  /** Call-only turn timing. Absent on browser voice, where the voice
   *  architecture's own measurements already cover the same path. */
  latency?: PhoneLatencyTracker;
}

export interface DeployedVoiceBindingOptions {
  /** The provider seam this attachment speaks through, already rotation-wrapped. */
  upstream: RealtimeUpstream;
  client: VoiceClientLink;
  deliveryPolicy: VoiceDeliveryPolicy;
}

interface ConfiguredDeployedVoiceOptions {
  toolDefinitions: RealtimeToolDefinition[];
  profile: DeployedVoiceProfile;
  roleTools?: RoleTools;
}

export interface PreparedDeployedVoiceAttachment {
  readonly hasHistory: boolean;
  configure(
    profile: DeployedVoiceProfile,
    roleTools?: RoleTools,
  ): ConfiguredDeployedVoiceAttachment;
  dispose(): void;
}

export interface ConfiguredDeployedVoiceAttachment {
  readonly toolDefinitions: RealtimeToolDefinition[];
  attach(options: DeployedVoiceBindingOptions): Promise<DeployedVoiceAttachment>;
  dispose(): void;
}

type ActiveDeployedVoiceAttachmentOptions = DeployedVoicePreparationOptions &
  DeployedVoiceBindingOptions &
  ConfiguredDeployedVoiceOptions;

/**
 * Deployed-agent conversation attachment shared by browser voice and later
 * media transports. It owns context handoff, run delegation, narration, and
 * canonical history mapping; ingress owns authentication and wire framing.
 */
export class DeployedVoiceAttachment {
  readonly #options: ActiveDeployedVoiceAttachmentOptions;
  readonly #manager: RealtimeSessionManager;
  readonly #projector: VoiceContextProjector;
  readonly #cleanups = new Set<() => void>();
  readonly #speechEligibleRunIds = new Set<string>();
  readonly #originUpgrades = new Map<string, (requestText: string | null) => void>();
  readonly #attachedRunIds = new Set<string>();
  readonly #narrationByRun = new Map<string, (content: VoiceContentEvent) => void>();
  #armedAction: PendingActionRequest | null = null;
  #active = false;
  #disposed = false;
  #hasHistory = false;
  #releaseVoiceOwnership: (() => void) | null = null;

  private constructor(
    options: ActiveDeployedVoiceAttachmentOptions,
    manager: RealtimeSessionManager,
    projector: VoiceContextProjector,
  ) {
    this.#options = options;
    this.#manager = manager;
    this.#projector = projector;
    options.client.onClose(() => this.#dispose());
  }

  static async prepare(
    options: DeployedVoicePreparationOptions,
  ): Promise<PreparedDeployedVoiceAttachment> {
    const contextHandoff = new VoiceContentHandoff();
    const unsubscribeContext = options.session.subscribeContent(contextHandoff.observe);
    let durableContents: AgentContent[];
    try {
      durableContents = await options.sessionHistory.loadContent(options.session.sessionKey);
    } catch (error) {
      unsubscribeContext();
      throw error;
    }
    const grounding = buildDeployedGrounding({
      hasHistory: hasVoiceConversationHistory(
        [...durableContents, ...contextHandoff.pendingContent()],
        options.channel,
      ),
      capabilities: options.capabilities,
    });

    let state: 'prepared' | 'configured' | 'attached' | 'disposed' = 'prepared';
    const dispose = () => {
      if (state === 'attached' || state === 'disposed') {
        return;
      }
      state = 'disposed';
      unsubscribeContext();
    };
    return {
      hasHistory: grounding.hasHistory,
      configure: (profile, roleTools) => {
        if (state !== 'prepared') {
          throw new Error(`deployed voice attachment is already ${state}`);
        }
        const toolDefinitions = buildVoiceToolDefinitions(DEPLOYED_VOICE_VOCABULARY, roleTools);
        state = 'configured';
        return {
          toolDefinitions,
          attach: async (binding) => {
            if (state !== 'configured') {
              throw new Error(`deployed voice attachment is already ${state}`);
            }
            state = 'attached';
            try {
              return await DeployedVoiceAttachment.#attach(
                { ...options, ...binding, toolDefinitions, profile, roleTools },
                grounding,
                durableContents,
                contextHandoff,
                unsubscribeContext,
              );
            } catch (error) {
              state = 'disposed';
              unsubscribeContext();
              binding.client.close();
              throw error;
            }
          },
          dispose,
        };
      },
      dispose,
    };
  }

  static async #attach(
    options: ActiveDeployedVoiceAttachmentOptions,
    grounding: ReturnType<typeof buildDeployedGrounding>,
    durableContents: AgentContent[],
    contextHandoff: VoiceContentHandoff,
    unsubscribeContext: () => void,
  ): Promise<DeployedVoiceAttachment> {
    let attachment: DeployedVoiceAttachment | null = null;
    const projector = new VoiceContextProjector({
      appendLedger: (line) => {
        if (attachment) {
          attachment.#manager.appendLedgerItem(line);
        }
      },
      stripMarkdown: plainTextFromMarkdown,
      screen: options.screen,
    });
    const turnGateway = buildTurnGateway(
      options.session,
      options.messageProcessor,
      options.channel,
      options.runPresentation,
      (responseId, requestText) => {
        if (attachment) {
          attachment.#attachRun(responseId, requestText);
        }
      },
      options.latency,
    );
    const toolExecutor = new VoiceToolExecutorCore({
      port: createTurnPort({
        turns: turnGateway.turns,
        onRunStarted: turnGateway.reportRunStarted,
      }),
      vocab: DEPLOYED_VOICE_VOCABULARY,
      getArmedAction: () => {
        const currentAttachment = attachment;
        if (!currentAttachment) {
          return null;
        }
        return currentAttachment.#armedAction?.action ?? null;
      },
      clearArmedAction: () => {
        if (attachment) {
          attachment.#armedAction = null;
        }
      },
      onSessionEnd: () => {
        if (attachment) {
          attachment.#manager.endAfterCurrentResponse();
        }
      },
      roleTools: options.roleTools,
    });
    const manager = new RealtimeSessionManager({
      upstream: options.upstream,
      client: options.client,
      deliveryPolicy: options.deliveryPolicy,
      ...options.profile,
      // The visitor's browser opens this socket to load context; speech waits
      // for `activate()`, which is what keeps work that ran before they arrived
      // out of the conversation they hear.
      activation: 'deferred',
      getResponseContext: () => {
        const currentAttachment = attachment;
        return responseContext(
          options.session,
          projector.screenStateBlock(),
          currentAttachment ? currentAttachment.#armedAction : null,
        );
      },
      toolDefinitions: options.toolDefinitions,
      groundingText: grounding.text,
      toolExecutor,
      idleTimeoutMs: 2 * 60_000,
      maxSessionMs: 25 * 60_000,
      activeRunSilencePolicy: BROWSER_ACTIVE_RUN_SILENCE_POLICY,
      onRelayOutcome: (runId, outcome) => projector.noteRelayOutcome(runId, outcome),
      resolveClientMessage: options.resolveClientMessage,
      onHistoryBatch: async (batch) => {
        const contents = await options.sessionHistory.recordBatch(
          options.session.sessionKey,
          batch,
          options.channel,
        );
        for (const content of contents) {
          options.session.pushContent(content);
        }
      },
    });
    attachment = new DeployedVoiceAttachment(options, manager, projector);
    attachment.#hasHistory = grounding.hasHistory;
    attachment.#cleanups.add(unsubscribeContext);
    attachment.#cleanups.add(() => projector.dispose());

    await manager.start();
    attachment.#seedConversation(durableContents);
    const pendingContents = contextHandoff.activate(durableContents, (content) => {
      if (attachment) {
        attachment.#handleRunContent(content);
      }
    });
    for (const content of pendingContents) {
      attachment.#handleRunContent(content);
    }
    return attachment;
  }

  get hasHistory(): boolean {
    return this.#hasHistory;
  }

  activate(options?: { speakFirst?: boolean }): void {
    if (this.#active || this.#disposed) {
      return;
    }
    this.#releaseVoiceOwnership = this.#options.session.acquireVoiceAttachment(() =>
      this.#revoke(),
    );
    this.#active = true;
    this.#cleanups.add(
      this.#options.session.subscribeAcceptedTurns((responseId) => {
        this.#speechEligibleRunIds.add(responseId);
        this.#manager.noteRunOutstanding(responseId);
      }),
    );
    try {
      this.#manager.activate({ speakFirst: options?.speakFirst ?? !this.#hasHistory });
    } catch (error) {
      this.#dispose();
      this.#manager.shutdown('activation failed');
      throw error;
    }
  }

  handleAttachmentEvent(event: Record<string, unknown>): void {
    this.#manager.handleClientEvent(event);
  }

  injectContext(text: string): void {
    this.#manager.injectContext(text);
  }

  /** Browser navigation revokes any action that belonged to the prior selected screen. */
  clearScreenAction(): void {
    this.#armedAction = null;
  }

  getTranscriptTail(): string {
    return this.#manager.getTranscriptTail();
  }

  /** Resolves once the ended attachment's final history writes have settled. */
  flushed(): Promise<void> {
    return this.#manager.flushed();
  }

  #attachRun(responseId: string, requestText: string | null): void {
    // The run's first broadcast content can outrace the delegation's
    // acceptance, in which case a lazily-attached handler already claimed
    // this id under the 'screen' assumption. Voice is discovered truth, not
    // a first-come claim: upgrade the existing handler instead of bailing.
    const upgrade = this.#originUpgrades.get(responseId);
    if (upgrade) {
      upgrade(requestText);
      return;
    }
    if (this.#attachedRunIds.has(responseId)) {
      return;
    }
    this.#attachedRunIds.add(responseId);
    let handleContent: (content: VoiceContentEvent) => void;
    handleContent = this.#createNarrationHandler(
      responseId,
      'voice',
      requestText,
      () => this.#speechEligibleRunIds.has(responseId),
      () => {
        if (this.#narrationByRun.get(responseId) === handleContent) {
          this.#narrationByRun.delete(responseId);
        }
      },
    );
    this.#narrationByRun.set(responseId, handleContent);
  }

  #attachScreenRun(responseId: string): void {
    if (this.#attachedRunIds.has(responseId)) {
      return;
    }
    this.#attachedRunIds.add(responseId);
    this.#manager.noteActivity();
    // The visitor drove this from the screen and reads the answer there; voice
    // records it as common ground rather than waiting to speak it.
    this.#projector.noteRunUnspoken(responseId);
    let handleContent: (content: VoiceContentEvent) => void;
    handleContent = this.#createNarrationHandler(
      responseId,
      'screen',
      null,
      () => this.#speechEligibleRunIds.has(responseId),
      () => {
        if (this.#narrationByRun.get(responseId) === handleContent) {
          this.#narrationByRun.delete(responseId);
        }
      },
    );
    this.#narrationByRun.set(responseId, handleContent);
  }

  #handleRunContent(content: VoiceContentEvent): void {
    if (
      content.type !== 'finish' &&
      content.type !== 'error' &&
      hasVoiceConversationHistory([content], this.#options.channel)
    ) {
      this.#hasHistory = true;
    }
    const responseId = content.responseId;
    if (!responseId) {
      return;
    }
    // The run's own user message is echoed under the same responseId before
    // the brain starts, so `role` is what separates "the caller was heard"
    // from "the brain answered".
    if (content.type === 'finish' || content.type === 'error') {
      this.#options.latency?.noteTurnEnded(responseId);
    } else if (content.role !== 'user') {
      this.#options.latency?.noteFirstContent(responseId);
    }
    if (!this.#narrationByRun.has(responseId)) {
      this.#attachScreenRun(responseId);
    }
    this.#narrationByRun.get(responseId)?.(content);
  }

  #createNarrationHandler(
    responseId: string,
    initialOrigin: 'voice' | 'screen',
    initialRequestText: string | null,
    speechEligible: () => boolean,
    onClosed: () => void,
  ): (content: VoiceContentEvent) => void {
    let origin = initialOrigin;
    let requestText = initialRequestText;
    if (initialOrigin === 'screen') {
      this.#originUpgrades.set(responseId, (voiceRequestText) => {
        origin = 'voice';
        requestText = voiceRequestText;
        this.#projector.noteRunSpoken(responseId);
      });
    }
    const policy = new ResponseSpeechPolicy({
      runId: responseId,
      origin: () => origin,
      schedule: (intent) => {
        if (speechEligible()) {
          // Relay only: a narration fires mid-run, and flushing the turn on it
          // would report the time to a progress line as the time to an answer.
          if (intent.kind === 'relay') {
            this.#options.latency?.noteRelayScheduled(intent.runId);
          }
          this.#manager.schedule(intent);
        }
      },
      onPendingAction: (request) => {
        log('info', {
          event: 'voice.pendingAction',
          toolName: request.toolName,
          toolCallId: request.toolCallId,
        });
        this.#armedAction = request;
        this.#manager.setRunLivenessSuspended(responseId, true);
      },
      onDisarm: () => {
        this.#armedAction = null;
        this.#manager.setRunLivenessSuspended(responseId, false);
      },
    });
    const observer = new TurnObserver({
      runId: responseId,
      detector: new SurfaceRenderDetector(),
      emit: (event) => {
        if (this.#options.screen.kind !== 'absent' || event.type !== 'ui-rendered') {
          policy.onEvent(event);
        }
        this.#projector.onEvent(responseId, event, requestText);
      },
    });
    let active = true;
    const cleanup = () => {
      if (!active) {
        return;
      }
      active = false;
      this.#cleanups.delete(cleanup);
      this.#originUpgrades.delete(responseId);
      onClosed();
    };
    const progressFacts = createDeployedProgressFacts(this.#options.formatStableMessage);
    const handleContent = (content: VoiceContentEvent) => {
      if (!active || content.responseId !== responseId) {
        return;
      }
      if (content.type === 'finish') {
        this.#manager.noteRunTerminal(responseId);
        observer.complete();
        cleanup();
        return;
      }
      if (content.type === 'error') {
        this.#manager.noteRunTerminal(responseId);
        observer.fail(content.error);
        cleanup();
        return;
      }
      observer.handle(progressFacts(content));
    };
    this.#cleanups.add(cleanup);
    return handleContent;
  }

  #seedConversation(durableContents: AgentContent[]): void {
    const contents = durableContents.map((content, index) => ({
      seq: index + 1,
      timestamp: 0,
      content,
    }));
    const summary = seedLedgerFromHistory({
      contents,
      projector: this.#projector,
      detector: new SurfaceRenderDetector(),
    });
    log('info', {
      event: 'voice.seed',
      sessionKey: this.#options.session.sessionKey,
      runs: summary.runs,
      surfaces: summary.surfaces,
    });
    const spokenConversation = projectSpokenDialogue(
      contents.map((item) => toRecallableContent(item.content)),
      this.#options.channel,
    ).slice(-24);
    for (const item of spokenConversation) {
      if (item.deliveryStatus === 'partial') {
        this.#manager.appendLedgerItem(item.text);
      } else {
        this.#manager.appendConversationMessage(item.role, item.text);
      }
    }
  }

  #dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#active = false;
    const releaseVoiceOwnership = this.#releaseVoiceOwnership;
    this.#releaseVoiceOwnership = null;
    releaseVoiceOwnership?.();
    for (const cleanup of this.#cleanups) {
      cleanup();
    }
    this.#cleanups.clear();
    this.#options.latency?.flushAll();
  }

  #revoke(): void {
    if (this.#disposed) {
      return;
    }
    this.#dispose();
    this.#manager.shutdown('attachment superseded');
  }
}

function buildTurnGateway(
  session: AgentSession,
  processor: DeployedVoiceTurnProcessor,
  channel: TurnChannel,
  runPresentation: AgentRunPresentationCapability,
  onRunStarted: (responseId: string, requestText: string | null) => void,
  latency?: PhoneLatencyTracker,
): { turns: VoiceTurnGateway; reportRunStarted: (responseId: string) => void } {
  const requestTextByRun = new Map<string, string>();
  const reportRunStarted = (responseId: string) => {
    const requestText = requestTextByRun.get(responseId) ?? null;
    requestTextByRun.delete(responseId);
    onRunStarted(responseId, requestText);
  };
  const observerPeer = createRunObserverPeer(reportRunStarted);
  const connectionId = `${channel}-${randomUUID()}`;
  const turns: VoiceTurnGateway = {
    startTurn: async (content) => {
      // Opened before the await: the send itself is part of the gap between
      // the caller falling silent and the brain hearing them.
      const forward = latency?.beginForward();
      const result = await processor.handleMessageSend(
        observerPeer,
        connectionId,
        session,
        {
          content,
          hidden: false,
          metadata: { channel },
        },
        runPresentation,
      );
      forward?.attach(result.responseId);
      requestTextByRun.set(result.responseId, content);
      return { queued: result.queued === true, responseId: result.responseId };
    },
    abortRun: async (responseId) => {
      await processor.handleMessageAbort(session, { responseId });
    },
    activeResponseId: () => processor.getActiveResponseId(session.sessionKey),
    sessionStatus: () => session.status,
    searchHistory: async (query) => {
      const contents = await session.getStoredContents(0);
      return searchStoredContents(
        contents.map((item) => toRecallableContent(item.content)),
        query,
        { spokenChannel: channel },
      );
    },
  };
  return { turns, reportRunStarted };
}

function createRunObserverPeer(onRunStarted: (responseId: string) => void): RpcPeer {
  const transport: ITransport = {
    isConnected: true,
    send: (packet) => {
      const payload = packet.payload;
      if (!isRecord(payload) || payload['method'] !== 'message.started') {
        return;
      }
      const params = payload['params'];
      if (isRecord(params) && typeof params['responseId'] === 'string') {
        onRunStarted(params['responseId']);
      }
    },
    on: () => {},
  };
  return new RpcPeer(transport);
}

function responseContext(
  session: AgentSession,
  screen: string,
  request: PendingActionRequest | null,
): string {
  const blocks = [formatVoiceLocaleSituation(session.presentationLocale), screen].filter(Boolean);
  if (!request) {
    return blocks.join('\n\n');
  }
  const options = request.action.options.map((option) => option.label).filter(Boolean);
  const optionsLine = options.length > 0 ? ` Options: ${options.join(', ')}.` : '';
  blocks.push(
    `PENDING SCREEN ACTION: ${request.action.label}.${optionsLine} If the visitor answers it by voice, call answer_pending_action with their answer — never answer it for them.`,
  );
  return blocks.join('\n\n');
}

function toRecallableContent(content: AgentContent): RecallableContent {
  return {
    responseId: content.responseId,
    role: content.role,
    hidden: content.hidden,
    channel: content.channel,
    voiceDelivery: content.voiceDelivery,
    isReasoning: content.type === ContentType.Text ? content.isReasoning : undefined,
    type: content.type,
    content: 'content' in content ? content.content : undefined,
  };
}
