import type { RpcPeer } from '../../vendor/agentplace-transport/RpcPeer.ts';
import type {
  AgentSessionOptions,
  SessionStatus,
  SessionClient,
  StoredContent,
  SessionInfo,
  PendingMessage,
  MessageSendParams,
} from './agent-session.types.ts';
import {
  type AgentContent,
  type AguiEvent,
  type IStateNode,
  type SessionSummary,
  type SessionPresentationLocale,
  isStreamingDelta,
  MemoryReplayBuffer,
} from '../bl/agent/agent-library.ts';
import type {
  FinishSignalContent,
  ErrorSignalContent,
  LocalizationBundleIdentity,
  LocaleSourceFallbackReason,
} from '../../../shared/index.ts';
import { AGUI_STREAM_METHOD, type AguiFrame } from '../../../shared/ws-protocol.ts';
import { uiStateSnapshotFrame } from './ui-state-frame.ts';
import { buildResyncFrames } from './resync-frames.ts';
import { snapshotSurface } from './surface-carry-forward.ts';
import type { SurfaceSnapshot } from '../types.ts';
import {
  resolveClick,
  type ClickResolution,
  type SurfaceContractCatalog,
} from './a2ui-click-resolver.ts';
import { buildVoiceScreen, type VoiceScreen } from './voice-screen.ts';
import { isRecord } from '../util/type-guards.ts';
import {
  reduceSurfaceEvent,
  type ReducedSurface,
} from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import { isA2uiEventName } from '../../vendor/agentplace-a2ui/event-names.ts';
import { ActionLog } from '../bl/action-log/action-log.ts';
import { agentConfig } from '../bl/config-bridge.ts';
import {
  SessionLocaleController,
  type SessionLocaleProposalSource,
} from './session-locale.controller.ts';

interface ClientLocalizationState {
  delivered: LocalizationBundleIdentity | null;
  deliveredAtMs: number | null;
  acknowledged: LocalizationBundleIdentity | null;
  fallback: {
    identity: LocalizationBundleIdentity;
    reason: LocaleSourceFallbackReason;
  } | null;
}

export type StableUiLocalizationStatus =
  | { status: 'no-browser'; attachmentCount: 0 }
  | { status: 'active'; attachmentCount: number }
  | { status: 'pending'; attachmentCount: number }
  | {
      status: 'source-fallback';
      attachmentCount: number;
      reason: LocaleSourceFallbackReason;
    };

/**
 * Represents a single agent session with state, content buffer, and connected clients.
 */
export class AgentSession {
  readonly sessionKey: string;
  readonly userId: string;
  readonly configId: string;
  readonly createdAt: Date;
  readonly actionLog: ActionLog;

  #ttlMs: number;
  #lastActivityAt: Date;
  #status: SessionStatus = 'idle';
  /**
   * True only while a run driven by THIS process is attached to this
   * session — set exclusively by `setStatus()`, the entry point every local
   * run driver (MessageProcessor, the HTTP send-message route) calls.
   * `bindStateSummary`'s subscription mirrors the state tree directly
   * (bypassing `setStatus()`) because that value can be authored by another
   * process (a trigger, or — after a dev-server restart — a run that died
   * with the old process and never got to write 'idle' back). The `status`
   * getter treats a `#status` of 'processing' with `#hasActiveRun` false as
   * proof that value is stale for THIS session and self-heals it.
   *
   * Single-process contract (verified: trigger/cron paths in container.ts
   * all resolve their session via `WsSessionManager.getOrCreate`): every run
   * driver shares this process's `AgentSession`, so a subscription-sourced
   * 'processing' without a local run is always boot-time staleness. Revisit
   * if runs ever drive sessions from another process.
   */
  #hasActiveRun = false;
  #clients = new Map<string, SessionClient>();
  #clientLocalization = new Map<string, ClientLocalizationState>();
  readonly #now: () => number;
  readonly #localeController: SessionLocaleController;

  // Content buffer — delegated to MemoryReplayBuffer
  #replayBuffer: MemoryReplayBuffer;
  #lastSeq = 0;

  // Message queue (max 1)
  #pendingMessage: PendingMessage | null = null;

  // State tree subscription — keeps status in sync with the authoritative source
  #stateUnsubscribe: (() => void) | null = null;
  // uiState node subscription — broadcasts STATE snapshots to connected clients
  #uiStateUnsubscribe: (() => void) | null = null;
  /** Passive observers of the content channel (e.g. the voice narration tap) —
   *  separate from `#clients`, which are real WS connections fanned out via `broadcast()`. */
  #contentSubscribers = new Set<
    (
      content: (AgentContent | FinishSignalContent | ErrorSignalContent) & { responseId?: string },
    ) => void
  >();
  /**
   * Live-only turn-admission signal. It deliberately has no replay: a voice
   * attachment hears only turns accepted after it subscribes, while the
   * content channel remains the complete context projection.
   */
  #acceptedTurnSubscribers = new Set<(responseId: string) => void>();
  /** The one deployed voice attachment currently listening to prospective turns. */
  #activeVoiceAttachment: { token: symbol; revoke: () => void } | null = null;
  /** Latest uiState value (cached from the node) — the resync source. */
  #lastUiState: Record<string, unknown> | null = null;
  /** Surface the most recent a2ui event touched — used by session-global UI actions. */
  #lastRenderedSurfaceId: string | null = null;
  /** Current-surface reduction of the a2ui frames this session broadcast —
   *  the resync source for reconnecting clients. */
  #a2uiSurfaces = new Map<string, ReducedSurface>();
  /** Latest terminal Surface content identity per surface, rebuilt from ordinary content history. */
  #lastTurnError: { responseId: string | null; error: string } | null = null;

  constructor(options: AgentSessionOptions) {
    this.sessionKey = options.sessionKey;
    this.userId = options.userId;
    this.configId = options.configId;
    this.createdAt = new Date();
    this.#lastActivityAt = new Date();
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#localeController = new SessionLocaleController({
      sourceLocale: agentConfig().localization.sourceLocale,
      selectMessageLocale: options.messageLocaleSelector,
    });

    this.actionLog = new ActionLog();
    this.#replayBuffer = new MemoryReplayBuffer({ maxEvents: 500 });
    void this.#replayBuffer.startStream(this.sessionKey);

    console.log(`[AgentSession] Created session ${this.sessionKey} for user ${this.userId}`);
  }

  /**
   * Bind to a state tree summary node for real-time status synchronization.
   * When the state tree status changes (e.g., from a trigger or agent run),
   * the local status is updated and all connected clients are notified.
   */
  bindStateSummary(summaryNode: IStateNode<SessionSummary>): void {
    this.#stateUnsubscribe?.();

    this.#stateUnsubscribe = summaryNode.subscribe((event) => {
      if (event.change === 'delete') {
        return;
      }
      this.#applyStateSummary(event.value as SessionSummary | null, { broadcast: true });
    });

    // Subscriptions fire on CHANGE only — pull the current value once so a
    // session recreated on reconnect (or one that just bound late) starts
    // with the durable status instead of the 'idle' default. No broadcast:
    // nothing is connected yet at bind time (see WsSessionManager.getOrCreate).
    void summaryNode
      .load()
      .then(() => this.#applyStateSummary(summaryNode.data, { broadcast: false }))
      .catch(() => {});
  }

  #applyStateSummary(summary: SessionSummary | null, options: { broadcast: boolean }): void {
    if (!summary?.status) {
      return;
    }
    // Map agent-library statuses to the WS protocol subset
    const wsStatus: SessionStatus = summary.status === 'processing' ? 'processing' : 'idle';
    if (wsStatus === this.#status) {
      return;
    }
    this.#status = wsStatus;
    this.touch();
    if (options.broadcast) {
      this.broadcast({ method: 'session.statusChanged', params: { status: wsStatus } });
    }
  }

  /**
   * Bind to the session's `uiState` StateTree node. On every change the latest
   * value is broadcast to connected clients as an AG-UI STATE_SNAPSHOT on the
   * `agui` channel (the deployed client has no StateTree — it receives uiState
   * over the event wire like content). The empty `responseId` marks the frame
   * as not run-scoped.
   */
  bindStateUiState(uiStateNode: IStateNode<Record<string, unknown>>): void {
    this.#uiStateUnsubscribe?.();

    this.#uiStateUnsubscribe = uiStateNode.subscribe((event) => {
      if (event.change === 'delete') {
        this.#lastUiState = null;
        return;
      }
      this.#lastUiState = (event.value as Record<string, unknown> | null) ?? null;
      const frame = uiStateSnapshotFrame(this.#lastUiState);
      this.broadcast({ method: AGUI_STREAM_METHOD, params: frame });
      this.touch();
    });

    // Subscriptions fire on CHANGE only — pull the current value once so a
    // client connecting into an existing session can be resynced.
    void uiStateNode
      .load()
      .then(() => {
        if (this.#lastUiState === null && uiStateNode.data) {
          this.#lastUiState = uiStateNode.data as Record<string, unknown>;
        }
      })
      .catch(() => {});
  }

  bindStatePresentationLocale(
    node: IStateNode<SessionPresentationLocale>,
  ): Promise<SessionPresentationLocale> {
    return this.#localeController.bind(node);
  }

  get presentationLocale(): SessionPresentationLocale {
    return this.#localeController.current;
  }

  proposeLocale(
    locale: string,
    source: SessionLocaleProposalSource,
  ): Promise<SessionPresentationLocale> {
    return this.#localeController.propose(locale, source);
  }

  /** Reduce a broadcast agui event into the session's current-surface view
   *  (called by the stream consumer for a2ui CUSTOM events). */
  recordA2uiEvent(event: AguiEvent, responseId?: string): void {
    if (event.type === 'CUSTOM' && isA2uiEventName(event.name)) {
      reduceSurfaceEvent(this.#a2uiSurfaces, event.name, event.value, responseId);
      const surfaceId = readSurfaceId(event.value);
      if (surfaceId) {
        this.#lastRenderedSurfaceId = surfaceId;
      }
    }
  }

  /**
   * The session's own latest state of one rendered surface, resolved fresh on
   * every read. The browser names only the surface — never a render version —
   * so a mid-render or just-re-rendered screen resolves to what the visitor
   * sees now instead of racing an anchor over the wire. A surface this session
   * never rendered resolves to null, which is the authorization boundary.
   */
  screenForVoice(surfaceId: string): VoiceScreen | null {
    return buildVoiceScreen(this.#a2uiSurfaces.get(surfaceId), this.#lastUiState, surfaceId);
  }

  /** A named control on the current screen, resolved into the payload a real press sends —
   *  assembled by `resolveClick`; this session only holds the screen-side inputs. The
   *  contract catalog comes from the caller so this stays free of the tool graph. */
  resolveClick(
    request: { button: string; context?: Record<string, unknown> },
    catalog: SurfaceContractCatalog,
  ): ClickResolution {
    return resolveClick({
      surfaceId: this.#lastRenderedSurfaceId,
      surface: this.#lastRenderedSurfaceId
        ? this.#a2uiSurfaces.get(this.#lastRenderedSurfaceId)
        : undefined,
      uiState: this.#lastUiState,
      requested: request.button,
      catalog,
      suppliedContext: request.context,
    });
  }

  /** The snapshot frames a (re)connecting client needs to rebuild the stage. */
  buildResyncFrames(): Array<AguiFrame<AguiEvent>> {
    return buildResyncFrames(this.#lastUiState, this.#a2uiSurfaces);
  }

  /** Surface structure before the next render touches it. The tool layer owns
   * carry-forward policy; the session reports occupancy and ordered sections. */
  surfaceSnapshot(surfaceId: string): SurfaceSnapshot {
    return snapshotSurface(this.#a2uiSurfaces.get(surfaceId));
  }

  // --- Status ---

  /**
   * The ONLY way to observe status — every reader (websocket-handler's
   * `streamStatus` and `session.joined`, message-processor's queueing
   * decision, session-manager's sweep stats, voice-gateway) goes through
   * this getter, so a stale value self-heals everywhere at once instead of
   * per call site (six readers were missed patching `getInfo()` alone —
   * see `#resolveReportedStatus`'s history in git blame).
   *
   * `#status` can read 'processing' with no live run behind it — most
   * commonly right after a dev-server restart, when `bindStateSummary`'s
   * initial pull brings in a durable summary a run wrote before the old
   * process died mid-run and never got to set back to 'idle'.
   * `#hasActiveRun` is only true while a LOCAL run driver (`setStatus`)
   * actually has one attached to THIS session, so a 'processing' value
   * with `#hasActiveRun` false is unambiguous staleness — never a
   * legitimate out-of-band run, which would have reached this session via
   * `setStatus` too (every run driver operates on the shared `AgentSession`
   * returned by `WsSessionManager.getOrCreate`). Heals `#status` in place
   * so later reads agree without re-deriving this.
   *
   * Heals only the LOCAL value — deliberately never writes 'idle' back to
   * the durable summary (a read path must not mutate authoritative state;
   * the stale durable value is tolerated and re-healed on each read).
   */
  get status(): SessionStatus {
    if (this.#status === 'processing' && !this.#hasActiveRun) {
      this.#status = 'idle';
    }
    return this.#status;
  }

  /**
   * True only while a run driven by THIS process is attached to this
   * session (see `#hasActiveRun`). Hydration guard: `session-hydration.ts`
   * keys its don't-cache-into-a-live-buffer guard on this, not on `status`
   * — `status` can read 'processing' from a `bindStateSummary` pull that is
   * merely stale (boot-time staleness, or a value authored by another
   * process) until something reads the `status` getter and self-heals it,
   * which would wrongly skip buffering in the meantime.
   */
  get hasActiveRun(): boolean {
    return this.#hasActiveRun;
  }

  /**
   * The public entry point every LOCAL run driver calls (MessageProcessor,
   * the HTTP send-message route) — the source of `#hasActiveRun`'s truth.
   * `bindStateSummary`'s subscription intentionally bypasses this method
   * (writes `#status` directly) so the `status` getter can tell "a run is
   * live in THIS process" apart from "the state tree says processing".
   */
  setStatus(status: SessionStatus): void {
    if (status === 'processing') {
      this.#lastTurnError = null;
    }
    this.#status = status;
    this.#hasActiveRun = status === 'processing';
    this.touch();
  }

  // --- Client Management ---

  get clientCount(): number {
    return this.#clients.size;
  }

  get hasClients(): boolean {
    return this.#clients.size > 0;
  }

  addClient(connectionId: string, client: SessionClient): void {
    this.#clients.set(connectionId, client);
    this.openLocalizationAttachment(connectionId);
    this.touch();
    console.log(
      `[AgentSession] Client connected to ${this.sessionKey}, count: ${this.#clients.size}`,
    );
  }

  removeClient(connectionId: string): void {
    this.#clients.delete(connectionId);
    this.closeLocalizationAttachment(connectionId);
    console.log(
      `[AgentSession] Client disconnected from ${this.sessionKey}, count: ${this.#clients.size}`,
    );
  }

  broadcast(message: { method: string; params: unknown }): void {
    for (const client of this.#clients.values()) {
      client.rpcPeer.notify(message, { requireAck: false }).catch(() => {});
    }
  }

  notifyClient(connectionId: string, message: { method: string; params: unknown }): boolean {
    const client = this.#clients.get(connectionId);
    if (!client) {
      return false;
    }
    client.rpcPeer.notify(message, { requireAck: false }).catch(() => {});
    return true;
  }

  openLocalizationAttachment(connectionId: string): void {
    this.#clientLocalization.set(connectionId, {
      delivered: null,
      deliveredAtMs: null,
      acknowledged: null,
      fallback: null,
    });
  }

  closeLocalizationAttachment(connectionId: string): void {
    this.#clientLocalization.delete(connectionId);
  }

  recordLocalizationDelivery(connectionId: string, identity: LocalizationBundleIdentity): boolean {
    const state = this.#clientLocalization.get(connectionId);
    if (!state || sameBundleIdentity(state.delivered, identity)) {
      return false;
    }
    state.delivered = { ...identity };
    state.deliveredAtMs = this.#now();
    state.fallback = null;
    return true;
  }

  recordLocalizationFallback(
    connectionId: string,
    identity: LocalizationBundleIdentity,
    reason: LocaleSourceFallbackReason,
  ): boolean {
    const state = this.#clientLocalization.get(connectionId);
    if (!state) {
      return false;
    }
    state.fallback = { identity: { ...identity }, reason };
    return true;
  }

  acknowledgeLocalization(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): { accepted: false } | { accepted: true; activationLagMs: number } {
    const state = this.#clientLocalization.get(connectionId);
    if (!state || !sameBundleIdentity(state.delivered, identity)) {
      return { accepted: false };
    }
    state.acknowledged = { ...identity };
    state.fallback = null;
    const acknowledgedAtMs = this.#now();
    const activationLagMs = Math.max(
      0,
      acknowledgedAtMs - (state.deliveredAtMs ?? acknowledgedAtMs),
    );
    return { accepted: true, activationLagMs };
  }

  localizationActivation(connectionId: string): LocalizationBundleIdentity | null {
    const acknowledged = this.#clientLocalization.get(connectionId)?.acknowledged;
    return acknowledged ? { ...acknowledged } : null;
  }

  get localizationAttachmentIds(): string[] {
    return [...this.#clientLocalization.keys()];
  }

  restoreLocalizationActivation(
    connectionId: string,
    identity: LocalizationBundleIdentity,
  ): boolean {
    const state = this.#clientLocalization.get(connectionId);
    if (!state) {
      return false;
    }
    state.delivered = { ...identity };
    state.deliveredAtMs = this.#now();
    state.acknowledged = { ...identity };
    state.fallback = null;
    return true;
  }

  localizationStatus(
    identity: LocalizationBundleIdentity,
    attachmentId?: string,
  ): StableUiLocalizationStatus {
    const originatingState = attachmentId ? this.#clientLocalization.get(attachmentId) : undefined;
    const states = originatingState ? [originatingState] : [...this.#clientLocalization.values()];
    if (states.length === 0) {
      return { status: 'no-browser', attachmentCount: 0 };
    }
    if (states.every((state) => sameBundleIdentity(state.acknowledged, identity))) {
      return { status: 'active', attachmentCount: states.length };
    }
    const allFellBack = states.every(
      (state) => state.fallback && sameBundleIdentity(state.fallback.identity, identity),
    );
    const fallback = states[0]?.fallback;
    if (allFellBack && fallback) {
      return {
        status: 'source-fallback',
        attachmentCount: states.length,
        reason: fallback.reason,
      };
    }
    return { status: 'pending', attachmentCount: states.length };
  }

  // --- Content Broadcasting & Storage ---

  /**
   * Broadcast content to all connected clients.
   * The content may include a responseId for grouping.
   */
  broadcastContent(
    content: (AgentContent | FinishSignalContent | ErrorSignalContent) & { responseId?: string },
  ): void {
    if (content.type === 'error') {
      this.recordTurnError(content.error, content.responseId);
    }
    this.broadcast({
      method: 'content',
      params: content,
    });
    for (const subscriber of this.#contentSubscribers) {
      subscriber(content);
    }
  }

  /** A run that gave up says so in plain text and closes its stream cleanly, so nothing
   *  durable distinguishes an outage from an agent that answered badly. This does. */
  recordTurnError(error: string, responseId?: string): void {
    this.#lastTurnError = { responseId: responseId ?? null, error };
  }

  get lastTurnError(): { responseId: string | null; error: string } | null {
    return this.#lastTurnError;
  }

  /**
   * Subscribes a passive observer to every content-channel item this session
   * broadcasts (regular content plus the terminal finish/error signal), for
   * the whole session lifetime — not scoped to one run. Callers filter by
   * `responseId` themselves. Returns an unsubscribe function.
   */
  subscribeContent(
    handler: (
      content: (AgentContent | FinishSignalContent | ErrorSignalContent) & { responseId?: string },
    ) => void,
  ): () => void {
    this.#contentSubscribers.add(handler);
    return () => this.#contentSubscribers.delete(handler);
  }

  /** Announces that a user turn has crossed the session's admission boundary. */
  notifyTurnAccepted(responseId: string): void {
    for (const subscriber of this.#acceptedTurnSubscribers) {
      subscriber(responseId);
    }
  }

  /**
   * Subscribe prospectively to accepted turns. Existing and already-queued
   * turns are intentionally absent, even if their output arrives later.
   */
  subscribeAcceptedTurns(handler: (responseId: string) => void): () => void {
    this.#acceptedTurnSubscribers.add(handler);
    return () => this.#acceptedTurnSubscribers.delete(handler);
  }

  /**
   * Makes one deployed voice attachment the prospective listener. Replacing
   * it revokes the old attachment synchronously; token-guarded release keeps
   * a late close from clearing the replacement.
   */
  acquireVoiceAttachment(revoke: () => void): () => void {
    const token = Symbol('voice-attachment');
    const previous = this.#activeVoiceAttachment;
    this.#activeVoiceAttachment = { token, revoke };
    previous?.revoke();
    return () => {
      if (this.#activeVoiceAttachment?.token === token) {
        this.#activeVoiceAttachment = null;
      }
    };
  }

  /** True while the session has an active deployed voice listener. */
  get voiceChannelActive(): boolean {
    return this.#activeVoiceAttachment !== null;
  }

  /**
   * Store content (only final states, skip streaming deltas).
   * Text merging and ring buffer are handled by MemoryReplayBuffer.
   */
  pushContent(content: AgentContent): void {
    if (isStreamingDelta(content)) {
      return;
    }

    // captureEvent is async but purely in-memory (no I/O).
    // Fire-and-forget; track seq via .then() for the contentSeq getter.
    void this.#replayBuffer.captureEvent(this.sessionKey, content).then((seq) => {
      if (seq > 0) {
        this.#lastSeq = seq;
      }
    });
  }

  async getStoredContents(afterSeq: number = 0): Promise<StoredContent[]> {
    const { events } = await this.#replayBuffer.getEvents(this.sessionKey, afterSeq);
    return events.map((e) => ({
      seq: (e as { eventSeq?: number }).eventSeq ?? 0,
      timestamp: Date.now(),
      content: e as AgentContent,
    }));
  }

  get contentSeq(): number {
    return this.#lastSeq;
  }

  async getOldestContentSeq(): Promise<number> {
    const { events } = await this.#replayBuffer.getEvents(this.sessionKey);
    if (events.length === 0) {
      return 0;
    }
    return (events[0] as { eventSeq?: number }).eventSeq ?? 0;
  }

  // --- Message Queue ---

  get hasPendingMessage(): boolean {
    return this.#pendingMessage !== null;
  }

  /**
   * Queue a message. Returns false if queue is full (max 1).
   */
  queueMessage(
    id: string,
    params: MessageSendParams,
    rpcPeer: RpcPeer,
    connectionId: string,
    responseId: string,
  ): boolean {
    if (this.#pendingMessage !== null) {
      return false; // Queue full
    }
    this.#pendingMessage = { id, params, rpcPeer, connectionId, responseId };
    return true;
  }

  dequeueMessage(): PendingMessage | null {
    const msg = this.#pendingMessage;
    this.#pendingMessage = null;
    return msg;
  }

  // --- TTL & Activity ---

  touch(): void {
    this.#lastActivityAt = new Date();
  }

  isExpired(): boolean {
    const now = Date.now();
    const expireAt = this.#lastActivityAt.getTime() + this.#ttlMs;
    return now > expireAt;
  }

  get remainingTtlMs(): number {
    const now = Date.now();
    const expireAt = this.#lastActivityAt.getTime() + this.#ttlMs;
    return Math.max(0, expireAt - now);
  }

  // --- State Import ---

  /**
   * Atomically replace this session's replay buffer.
   * Used by the import-session endpoint to restore state from a snapshot.
   * Conversation history is managed by SessionManager (persistent).
   * Returns the final content sequence number.
   */
  async importState(storedContents: { content: unknown }[]): Promise<number> {
    await this.#replayBuffer.shutdown();
    this.#replayBuffer = new MemoryReplayBuffer({ maxEvents: 500 });
    await this.#replayBuffer.startStream(this.sessionKey);
    this.#lastSeq = 0;

    for (const item of storedContents) {
      const seq = await this.#replayBuffer.captureEvent(this.sessionKey, item.content);
      if (seq > 0) {
        this.#lastSeq = seq;
      }
    }

    this.touch();
    return this.#lastSeq;
  }

  // --- Cleanup ---

  cleanup(): void {
    const voiceAttachment = this.#activeVoiceAttachment;
    this.#activeVoiceAttachment = null;
    voiceAttachment?.revoke();
    this.#stateUnsubscribe?.();
    this.#stateUnsubscribe = null;
    this.#uiStateUnsubscribe?.();
    this.#uiStateUnsubscribe = null;
    this.#localeController.dispose();
    this.actionLog.flush();

    for (const client of this.#clients.values()) {
      try {
        client.ws.close(1000, 'Session ended');
      } catch {}
    }
    this.#clients.clear();
    this.#clientLocalization.clear();

    // MemoryReplayBuffer.shutdown() clears all streams and stops cleanup timer
    void this.#replayBuffer.shutdown();

    this.#pendingMessage = null;

    console.log(`[AgentSession] Cleaned up session ${this.sessionKey}`);
  }

  // --- Info ---

  async getInfo(): Promise<SessionInfo> {
    return {
      sessionKey: this.sessionKey,
      userId: this.userId,
      configId: this.configId,
      status: this.status,
      clientCount: this.#clients.size,
      contentSeq: this.#lastSeq,
      oldestContentSeq: await this.getOldestContentSeq(),
      createdAt: this.createdAt.toISOString(),
      remainingTtlMs: this.remainingTtlMs,
      voiceEngine: agentConfig().voice?.engine ?? 'v0',
    };
  }
}

function sameBundleIdentity(
  left: LocalizationBundleIdentity | null,
  right: LocalizationBundleIdentity,
): boolean {
  return (
    left?.catalogRevision === right.catalogRevision &&
    left.messageLocale === right.messageLocale &&
    left.sessionLocaleRevision === right.sessionLocaleRevision
  );
}

function readSurfaceId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const surfaceId = value['surfaceId'];
  return typeof surfaceId === 'string' && surfaceId ? surfaceId : null;
}
