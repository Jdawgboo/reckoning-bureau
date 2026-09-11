import { makeAutoObservable, observable, action, runInAction } from 'mobx';

import type { UserMessagePayloadT, SendMessagePropsT } from '@/app/lib/types';
import type { Attachment } from '@/app/lib/types/files';

import type { NotificationStore } from './NotificationsStore';
import type { MemoryStore } from './MemoryStore';
import { trpc } from '@/app/lib/trpc';
import { wsManager } from '@/app/lib/services/websocket-manager';
import type { AgentStreamContent } from '@/app/lib/services/websocket-client.types';
import { runBusyAfterVoiceState, type VoiceIndicatorState } from './voice-run-indicator';
import {
  ContentType,
  type AgentContent,
  type AgentMessagePayload,
  type ComponentContent,
  type ToolContent,
  type MessageGroup,
  type ConversationState,
  computeMessageGroups,
  AgentConversation,
} from '@/lib/agent-library';
import type { IStreamingStore } from '@/lib/agent-library';
import type { AguiFrame } from '../../../../../shared/ws-protocol.ts';
import { AgentStreamController } from './AgentStreamController.ts';
import { AguiClientConsumer } from './AguiClientConsumer.ts';
import { UiStateStore } from '../state/UiStateStore.ts';
import { A2uiSurfaceStore } from '../state/A2uiSurfaceStore.ts';
import { findProcessPagePart } from '../stage/process/active-part.ts';
import { NarrationStore } from '../stage/NarrationStore.ts';
import {
  resolveSignalToolUpdate,
  VOICE_TOOL_NAME,
  MEMORY_BANK_TOOL_NAME,
  type SignalToolUpdate,
} from './signal-tool-payload.ts';

const INITIAL_MESSAGE_TEXT = '[user opened the agent]';

export class MessagesStore implements IStreamingStore {
  userRequestPending = false;
  /** The most recent run that ended in an error, with the wire error message.
   *  Cleared when a new run starts; the stage's error notice keys on it. */
  lastRunError: { responseId: string; message: string } | null = null;
  lastVoiceText = '';
  speechEnabled = false;
  isRecordingAudio = false;
  /** Voice engine the server advertises via session.info — 'realtime' switches
   *  the omnibox voice mode onto the /voice WS engine; 'v0' keeps record-and-transcribe. */
  voiceEngine: 'v0' | 'realtime' = 'v0';
  /** Live caption from the realtime voice transcript deltas. */
  voiceCaption = '';
  /** The realtime voice session's turn state — 'thinking'/'building' tell the
   *  visitor the model heard them and is working (silence ≠ missed). */
  voiceState: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'building' = 'idle';
  /**
   * A voice utterance was forwarded to the agent and its run has not shown
   * anything yet. Separate from `voiceState` on purpose: that field tracks the
   * VOICE channel (listening/speaking) and is rewritten by every audio frame,
   * so the server's `building` push is overwritten the moment voice speaks its
   * acknowledgement — while the agent run it announced still has seconds to go.
   * A forwarded run is not visible in `userRequestPending` either: that is set
   * by client-initiated sends only, and this turn started on the server.
   */
  voiceRunBusy = false;
  voiceMuted = false;
  lastUpdatedComponentId: string | null = null;
  lastPopulatedComponentId: string | null = null;
  messages: AgentContent[] = [];
  /** toolCallIds of Subagent tool calls — used to filter their streamed text out of the main chat. */
  subagentToolCallIds: Set<string> = new Set();

  private conversation: AgentConversation;
  private hasInitializedSession = false;
  private unsubscribeAgui: (() => void) | null = null;
  /** Reduces the native AG-UI event stream into store content via the shared projector. */
  #aguiConsumer: AguiClientConsumer;
  /** Session uiState (A2UI data model), fed by STATE events off the same stream. */
  readonly uiState = new UiStateStore();
  /** A2UI surfaces. */
  readonly a2uiSurfaces = new A2uiSurfaceStore();
  /** Progress-as-narrative for the stage dock, fed by the agui consumer's
   *  observability tap. */
  readonly narration = new NarrationStore();

  readonly notificationsStore: NotificationStore;
  readonly memoryStore: MemoryStore;

  readonly #presentation: string;

  #streamController!: AgentStreamController;

  /** Session-only: files are not persisted in history, so live-turn
   *  thumbnails resolve here (keyed by decorated request text); reloads
   *  fall back to marker-parsed filename chips. */
  #sentAttachments = new Map<string, Attachment[]>();

  rememberSentAttachments(requestText: string, files: Attachment[]): void {
    this.#sentAttachments.set(requestText, files);
    if (this.#sentAttachments.size > 20) {
      const oldest = this.#sentAttachments.keys().next().value;
      if (oldest !== undefined) {
        this.#sentAttachments.delete(oldest);
      }
    }
  }

  attachmentsForRequest(requestText: string): Attachment[] | undefined {
    return this.#sentAttachments.get(requestText);
  }

  constructor({
    notificationsStore,
    memoryStore,
    presentation,
  }: {
    notificationsStore: NotificationStore;
    memoryStore: MemoryStore;
    presentation: string;
  }) {
    this.notificationsStore = notificationsStore;
    this.memoryStore = memoryStore;
    this.#presentation = presentation;

    this.conversation = new AgentConversation({
      onStateChange: action((state: ConversationState) => {
        this.messages = state.messages;
      }),
    });

    this.#aguiConsumer = new AguiClientConsumer(
      (content) => this.processContent(content),
      (event) => this.uiState.applyStateEvent(event),
      (name, value, responseId) => this.a2uiSurfaces.applySurfaceEvent(name, value, responseId),
      (event) => {
        this.narration.handle(event);
      },
    );

    makeAutoObservable<this, 'conversation' | 'hasInitializedSession' | 'unsubscribeAgui'>(
      this,
      {
        messages: observable.ref,
        conversation: false,
        hasInitializedSession: false,
        unsubscribeAgui: false,
        notificationsStore: false,
        memoryStore: false,
        uiState: false,
        a2uiSurfaces: false,
        narration: false,
      },
      { autoBind: true },
    );

    this.#streamController = new AgentStreamController(this, wsManager, {
      onExhausted: () => {
        runInAction(() => this.setUserRequestPending(false));
      },
    });
  }

  get groupedMessages(): MessageGroup[] {
    return computeMessageGroups(this.messages);
  }

  get contents(): AgentContent[] {
    return this.messages;
  }

  /**
   * Concatenated assistant text streamed from a subagent. Each delta lives
   * in `this.messages` as a TextContent with `messageId = "<toolCallId>:<childId>"`,
   * emitted by SubagentToolModel via `ctx.streamText` in the parent's UI
   * stream (see agent.service.ts). Reasoning tokens are filtered out.
   */
  getSubagentAssistantText(toolCallId: string): string {
    if (!toolCallId) {
      return '';
    }
    const prefix = `${toolCallId}:`;
    let text = '';
    for (const m of this.messages) {
      if (!m.messageId?.startsWith(prefix)) {
        continue;
      }
      if (m.type !== ContentType.Text) {
        continue;
      }
      if ((m as { isReasoning?: boolean }).isReasoning) {
        continue;
      }
      text += m.content;
    }
    return text;
  }

  /** Latest non-reasoning text block from the subagent — used for live preview
   *  while the child is running. Each messageId corresponds to one model step. */
  getSubagentLatestText(toolCallId: string): string {
    if (!toolCallId) {
      return '';
    }
    const prefix = `${toolCallId}:`;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (!m.messageId?.startsWith(prefix)) {
        continue;
      }
      if (m.type !== ContentType.Text) {
        continue;
      }
      if ((m as { isReasoning?: boolean }).isReasoning) {
        continue;
      }
      return m.content as string;
    }
    return '';
  }

  resetToInitialState() {
    this.resetComponentTracking();
    this.rebuildSubagentToolCallIds();
  }

  /**
   * Recompute `subagentToolCallIds` from the current messages list.
   * Called after `conversation.restore()` because that path bulk-replaces
   * messages without going through `processContent` — without this rebuild,
   * historical Subagent components would not be in the Set, and their
   * streamed text would leak into the main chat.
   */
  private rebuildSubagentToolCallIds() {
    this.subagentToolCallIds.clear();
    for (const m of this.messages) {
      this.trackSubagentToolCallId(m);
    }
  }

  processContent(content: AgentStreamContent) {
    if (this.handleSystemContent(content)) {
      return;
    }

    if (content.type === 'finish' || content.type === 'error') {
      return;
    }

    if (isStreamingSurfaceContent(content)) {
      return;
    }

    this.trackSubagentToolCallId(content);
    this.narration.handleToolPart(content);
    this.conversation.process(content as AgentMessagePayload);
  }

  /** The part whose page the stage shows — upgrades within a run, never downgrades. */
  get activeProcessPart(): ComponentContent | null {
    return findProcessPagePart(this.contents);
  }

  // === IStreamingStore implementation ===

  processMessage(_configId: string, payload: AgentMessagePayload): void {
    this.processContent(payload as AgentStreamContent);
  }

  clearStreamingMessages(_configId: string): void {
    runInAction(() => {
      this.conversation.clearStreamingMessages();
    });
  }

  restore(_configId: string, items: AgentContent[]): void {
    runInAction(() => {
      this.conversation.restore({ messages: items });
      this.resetToInitialState();
    });
  }

  /**
   * True if `messageId` is scoped to a known Subagent tool call.
   * Subagent text streamed to the parent gets messageId
   * `<subagentToolCallId>:<childMessageId>` (see agent.service.ts:streamText)
   * — we strip those from the main chat and re-render them inside the
   * Subagent component instead.
   */
  isSubagentScoped(messageId: string | undefined): boolean {
    if (!messageId) {
      return false;
    }
    const colonIdx = messageId.indexOf(':');
    if (colonIdx < 0) {
      return false;
    }
    return this.subagentToolCallIds.has(messageId.slice(0, colonIdx));
  }

  /** Accepts both `AgentStreamContent` (live WS frames) and `AgentContent`
   *  (history items from `conversation.restore()`) — the function only reads
   *  fields shared by both unions. */
  private trackSubagentToolCallId(content: AgentContent | AgentStreamContent) {
    const c = content as ComponentContent & { componentName?: string };
    if (c.type !== ContentType.Component) {
      return;
    }
    if (c.componentName !== 'Subagent') {
      return;
    }
    const tcId = c.streaming?.toolCallId;
    if (tcId) {
      this.subagentToolCallIds.add(tcId);
    }
  }

  async sendMessage(props: SendMessagePropsT): Promise<void> {
    if (this.userRequestPending) {
      await this.abortCurrentRequest({ waitForServerAck: true });
    }

    try {
      this.setUserRequestPending(true);
      const completionPromise = this.#streamController.beginRequest();

      const messagePayload = this.createMessagePayload(props);

      await this.transcribeAudioIfNeeded(messagePayload);
      const content = this.extractMessageContent(messagePayload);
      const metadata = this.createRequestMetadata(props, messagePayload);

      const result = await wsManager.sendMessage(content, {
        files: props.files,
        memoryBank: this.memoryStore.getAll(),
        metadata,
        presentation: this.#presentation,
      });
      this.#streamController.trackStream(result?.responseId ?? null);
      await completionPromise;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'CanceledError') {
        return;
      }
      this.#streamController.cancelRequest();
      this.setUserRequestPending(false);
      throw error;
    }
  }

  /**
   * Query-mode send: behaves like `sendMessage()` from a UI perspective
   * (pending/progress), but also returns a `responseId` for correlation.
   *
   * The caller is responsible for awaiting `done` to know when the request finished.
   */
  async sendMessageForQuery(
    props: SendMessagePropsT,
  ): Promise<{ responseId: string; done: Promise<void> }> {
    if (this.userRequestPending) {
      throw new Error('Message already pending');
    }

    try {
      this.setUserRequestPending(true);
      const done = this.#streamController.beginRequest();

      const messagePayload = this.createMessagePayload(props);

      await this.transcribeAudioIfNeeded(messagePayload);
      const content = this.extractMessageContent(messagePayload);
      const metadata = this.createRequestMetadata(props, messagePayload);

      // Ensure WS is connected (idempotent, avoids depending on session init timing).
      await wsManager.connect();

      const { responseId } = await wsManager.sendMessageForQuery(content, {
        files: props.files,
        metadata,
        hidden: content?.includes(INITIAL_MESSAGE_TEXT),
      });
      this.#streamController.trackStream(responseId ?? null);
      return { responseId, done };
    } catch (error: unknown) {
      this.#streamController.cancelRequest();
      this.setUserRequestPending(false);
      throw error;
    }
  }

  stopStreaming() {
    void this.abortCurrentRequest({ waitForServerAck: false });
  }

  /**
   * Initialize session: connect WebSocket, subscribe to content, and either
   * rehydrate existing content or trigger welcome flow for fresh sessions.
   */
  async initializeSession(): Promise<void> {
    if (this.hasInitializedSession) {
      return;
    }
    this.hasInitializedSession = true;

    await wsManager.connect();

    if (!this.unsubscribeAgui) {
      this.unsubscribeAgui = wsManager.onAgui((frame) => {
        this.#aguiConsumer.consume(frame);
      });

      wsManager.onReconnect(() => {
        const state = this.#streamController.state;
        if (state === 'streaming' || state === 'paused') {
          this.#streamController.notifyDisconnected();
        } else if (this.#streamController.hasPending) {
          wsManager.getSessionInfo().then(
            action((info) => {
              if (info.status === 'idle' && this.#streamController.resolvePendingIfActive()) {
                this.setUserRequestPending(false);
              }
            }),
          );
        }
      });
    }

    const buffered: AguiFrame[] = [];
    let isRestoring = true;
    const unsubscribeRestoreBuffer = wsManager.onAgui((frame) => {
      if (isRestoring) {
        buffered.push(frame);
      }
    });

    const [queryResult, sessionInfo] = await Promise.all([
      wsManager.queryContent(0),
      wsManager.getSessionInfo(),
    ]);

    this.setVoiceEngine(sessionInfo.voiceEngine ?? 'v0');

    this.conversation.restore({
      messages: queryResult.items.map((i) => i.content),
    });

    this.resetToInitialState();
    isRestoring = false;
    unsubscribeRestoreBuffer();

    for (const frame of buffered) {
      this.#aguiConsumer.consume(frame);
    }

    if (queryResult.items.length === 0 && sessionInfo.status !== 'processing') {
      this.sendWelcomeMessage().catch((error) => {
        console.error('[MessagesStore] Welcome message failed:', error);
      });
    }

    if (sessionInfo.status === 'processing') {
      this.setUserRequestPending(true);
      this.#streamController.trackStreamOnly();
    }
  }

  /**
   * Sends the welcome message with memory bank to trigger the agent's initial greeting.
   * Called automatically on fresh sessions (no prior content).
   */
  private async sendWelcomeMessage(): Promise<void> {
    if (this.userRequestPending) {
      return;
    }

    this.setUserRequestPending(true);
    const completionPromise = this.#streamController.beginRequest();

    try {
      const memoryBank = this.memoryStore.getAll();
      const result = await wsManager.sendMessage('', {
        memoryBank,
        hidden: true,
        presentation: this.#presentation,
        metadata: {
          systemMessage: INITIAL_MESSAGE_TEXT,
          requestType: 'agent_opened',
        },
      });
      this.#streamController.trackStream(result?.responseId ?? null);

      await completionPromise;
    } catch (error: unknown) {
      this.#streamController.cancelRequest();
      this.setUserRequestPending(false);
      throw error;
    }
  }

  clearMessages() {
    this.lastVoiceText = '';

    void this.abortCurrentRequest({ waitForServerAck: false, reason: 'Messages cleared' });

    this.userRequestPending = false;
    this.lastUpdatedComponentId = null;
    this.lastPopulatedComponentId = null;
    this.conversation.clear();
    this.messages = [];
    this.subagentToolCallIds.clear();
  }

  private async abortCurrentRequest(options?: {
    waitForServerAck?: boolean;
    reason?: string;
  }): Promise<void> {
    if (!this.#streamController.hasPending && this.#streamController.state === 'idle') {
      this.setUserRequestPending(false);
      return;
    }

    const responseId = this.#streamController.activeResponseId;
    if (responseId) {
      const abortPromise = wsManager.abortStream(responseId).catch(() => {});
      if (options?.waitForServerAck) {
        await abortPromise;
      }
    }

    this.#streamController.abort();
    this.setUserRequestPending(false);
  }

  clearPageContent() {
    this.resetComponentTracking();
  }

  toggleSpeech() {
    this.speechEnabled = !this.speechEnabled;
    if (!this.speechEnabled) {
      this.isRecordingAudio = false;
      this.voiceCaption = '';
      this.voiceState = 'idle';
      this.voiceRunBusy = false;
      this.voiceMuted = false;
    }
  }

  setVoiceState(state: VoiceIndicatorState) {
    this.voiceState = state;
    this.voiceRunBusy = runBusyAfterVoiceState(this.voiceRunBusy, state);
  }

  /** The server's `voice.run` edge — the only thing that raises or finishes the run indicator. */
  setVoiceRunBusy(busy: boolean) {
    this.voiceRunBusy = busy;
  }

  setVoiceMuted(muted: boolean) {
    this.voiceMuted = muted;
  }

  setVoiceEngine(engine: 'v0' | 'realtime') {
    this.voiceEngine = engine;
  }

  setVoiceCaption(text: string) {
    this.voiceCaption = text;
  }

  toggleRecordingAudio(isRecording: boolean) {
    this.isRecordingAudio = isRecording;
  }

  updateLastVoiceText(text: string) {
    this.lastVoiceText = text;
  }

  setLastUpdatedComponentId(componentId: string | null) {
    this.lastUpdatedComponentId = componentId;
  }

  setLastPopulatedComponentId(componentId: string | null) {
    this.lastPopulatedComponentId = componentId;
  }

  /** Extract a string field from an AgentMessagePayload without unsafe casts. */
  static #field(payload: AgentStreamContent, key: string): string | undefined {
    const val = Reflect.get(payload as object, key);
    return typeof val === 'string' ? val : undefined;
  }

  private handleSystemContent(content: AgentStreamContent): boolean {
    if (content.type === 'finish') {
      const responseId = MessagesStore.#field(content, 'responseId');
      const handled = this.#streamController.handleTerminal('finish', responseId);
      if (handled) {
        this.finalizeStaleTools();
        this.setUserRequestPending(false);
      }
      return true;
    }

    if (content.type === 'error') {
      const responseId = MessagesStore.#field(content, 'responseId');
      const errorMessage = MessagesStore.#field(content, 'error') ?? 'Unknown error';
      const handled = this.#streamController.handleTerminal('error', responseId, errorMessage);
      if (handled) {
        if (responseId) {
          this.lastRunError = { responseId, message: errorMessage };
        }
        this.setUserRequestPending(false);
      }
      return true;
    }

    if (content.type === ContentType.Component) {
      const componentContent = content as ComponentContent;
      const toolName = componentContent.streaming?.toolName;
      if (toolName === VOICE_TOOL_NAME || toolName === MEMORY_BANK_TOOL_NAME) {
        this.applySignalToolUpdate(
          resolveSignalToolUpdate(toolName, componentContent.props, 'component'),
        );
        return true;
      }
    }

    if (content.type === ContentType.Tool) {
      const toolContent = content as ToolContent;
      const toolName = toolContent.tool?.name;
      if (toolName === VOICE_TOOL_NAME || toolName === MEMORY_BANK_TOOL_NAME) {
        this.applySignalToolUpdate(resolveSignalToolUpdate(toolName, toolContent.content, 'tool'));
        return true;
      }
    }

    return false;
  }

  /** Applies a resolved signal-tool update — see `signal-tool-payload.ts`. */
  private applySignalToolUpdate(update: SignalToolUpdate | null): void {
    if (!update) {
      return;
    }
    if (update.kind === 'voice') {
      this.updateLastVoiceText(update.text);
      return;
    }
    this.memoryStore.add(update.summary);
  }

  private setUserRequestPending(pending: boolean) {
    this.userRequestPending = pending;

    if (!pending) {
      this.resetComponentTracking();
    }
  }

  private resetComponentTracking() {
    this.lastUpdatedComponentId = null;
    this.lastPopulatedComponentId = null;
  }

  /**
   * Transition any tool components still stuck in active streaming states
   * (input-streaming, input-available, output-pending) to output-available.
   *
   * Some tools (e.g. native AI SDK tools like web_search) never emit the
   * full state machine transitions.  Cleaning up on `finish` ensures the
   * conversation model has correct terminal states for UI rendering and
   * session restore.
   */
  private finalizeStaleTools(): void {
    const staleTools: ComponentContent[] = [];
    for (const msg of this.messages) {
      if (msg.type !== ContentType.Component) {
        continue;
      }
      const comp = msg as ComponentContent;
      const s = comp.streaming?.state;
      if (s === 'input-streaming' || s === 'input-available' || s === 'output-pending') {
        staleTools.push(comp);
      }
    }

    if (staleTools.length === 0) {
      return;
    }

    // Push synthetic output-available updates through the conversation
    // so both the conversation model and this.messages stay in sync.
    for (const comp of staleTools) {
      this.conversation.process({
        type: ContentType.Component,
        messageId: comp.messageId,
        componentName: comp.componentName,
        props: {},
        streaming: {
          ...comp.streaming!,
          state: 'output-available',
        },
      } as AgentMessagePayload);
    }
  }

  private createMessagePayload(props: SendMessagePropsT): UserMessagePayloadT {
    if (props.audio) {
      return {
        id: crypto.randomUUID(),
        type: 'audio',
        content: { data: props.audio },
      };
    }
    return {
      id: crypto.randomUUID(),
      type: 'TXT',
      content: props.instruction || '',
    };
  }

  private extractMessageContent(messagePayload: UserMessagePayloadT): string {
    if (messagePayload.type === 'audio') {
      return (messagePayload.content.text as string) || '';
    }
    return typeof messagePayload.content === 'string'
      ? messagePayload.content
      : JSON.stringify(messagePayload.content);
  }

  private createRequestMetadata(
    props: SendMessagePropsT,
    messagePayload: UserMessagePayloadT,
  ): Record<string, unknown> | undefined {
    const baseMetadata = props.metadata ? { ...props.metadata } : {};
    const channel = baseMetadata.channel ?? (baseMetadata.a2uiAction ? 'screen' : 'omnibox');
    if (messagePayload.type === 'audio') {
      return {
        ...baseMetadata,
        channel,
        requestType: 'voice',
      };
    }
    return { ...baseMetadata, channel };
  }

  private async transcribeAudioIfNeeded(messagePayload: UserMessagePayloadT) {
    if (messagePayload.type !== 'audio') {
      return;
    }

    try {
      const result = await trpc.platform.transcribe.mutate({
        data: messagePayload.content.data as string,
      });
      messagePayload.content.text = result.text;
    } catch {
      // Audio transcription failed silently
    }
  }
}

/**
 * Surface tools stream partial input before a render is committed. Those
 * emissions carry no display or voice-authority value here — the stage renders
 * surfaces from `A2uiSurfaceStore`, never from this content — and rendering
 * them would flash a half-written screen and its anchor. Only the terminal
 * emission is real.
 */
function isStreamingSurfaceContent(content: AgentStreamContent): boolean {
  if (content.type !== ContentType.Component) {
    return false;
  }
  const component = content as ComponentContent;
  if (component.componentName !== 'Surface') {
    return false;
  }
  const state = component.streaming?.state;
  return state !== undefined && state !== 'output-available' && state !== 'output-error';
}
