/**
 * Shared WebSocket protocol types between agent-dev-server and agent-dev-client.
 *
 * These define the wire protocol — the shape of messages exchanged over the
 * WebSocket connection. Types that reference domain-specific content use a
 * generic `TContent = unknown`. Localization payloads reuse the adjacent
 * data-only bundle contract so browser and runtime cannot drift.
 */

import type {
  LocalizationBundle,
  LocalizationBundleIdentity,
  LocalizationFallbackReason,
  LocalizationLocale,
} from './localization.ts';

export type SessionStatus = 'idle' | 'processing';

export type SessionLocaleSource = 'default' | 'navigator' | 'conversation' | 'explicit';

export interface SessionPresentationLocale {
  messageLocale: LocalizationLocale;
  formatLocale: LocalizationLocale;
  source: SessionLocaleSource;
  revision: number;
}

export const LOCALE_HINT_METHOD = 'locale.hint';

export interface LocaleHintParams {
  locale: LocalizationLocale;
  activeBundle?: LocalizationBundleIdentity;
}

export const LOCALE_PROPOSE_METHOD = 'locale.propose';

export interface LocaleProposeParams {
  locale: LocalizationLocale;
}

export const LOCALE_COMMITTED_METHOD = 'locale.committed';

export interface LocaleCommittedParams {
  locale: SessionPresentationLocale;
  catalogRevision: string;
}

export const LOCALE_BUNDLE_READY_METHOD = 'locale.bundleReady';

export interface LocaleBundleReadyParams extends LocalizationBundleIdentity {
  bundle: LocalizationBundle;
}

export const LOCALE_SOURCE_FALLBACK_METHOD = 'locale.sourceFallback';

export type LocaleSourceFallbackReason = LocalizationFallbackReason;

export interface LocaleSourceFallbackParams extends LocalizationBundleIdentity {
  reason: LocaleSourceFallbackReason;
  retryAfterMs?: number;
}

export const LOCALE_ACTIVATED_METHOD = 'locale.activated';

export type LocaleActivatedParams = LocalizationBundleIdentity;

/**
 * WS notification method carrying the native AG-UI event stream, broadcast in
 * parallel to the `content` stream. The transport treats it as an opaque
 * event channel — only the consumer interprets the AG-UI payload — so the
 * method name lives here once rather than as a scattered magic string.
 */
export const AGUI_STREAM_METHOD = 'agui';

/**
 * Platform envelope for a single AG-UI event on the wire. The event itself
 * stays a pure AG-UI payload (`event`, generic so this file keeps zero
 * imports); `responseId` is the platform run-correlation id the client's
 * stream FSM gates terminal signals by — mirroring how `content` frames carry
 * `responseId` alongside the domain payload.
 */
export interface AguiFrame<TEvent = unknown> {
  responseId: string;
  event: TEvent;
}

/**
 * RPC method a client calls to write the session's `uiState` (the A2UI data
 * model / per-session UI state). Latest-wins full replace; the server echoes the
 * result to all tabs as an AG-UI STATE_SNAPSHOT.
 */
export const STATE_UPDATE_METHOD = 'state.update';

export interface StateUpdateParams {
  value: Record<string, unknown>;
  /** Reserved for A2UI per-surface scoping (e.g. '/surfaces/{id}'); unused in v1. */
  scope?: string;
}

/**
 * Stored content item with sequence number and timestamp.
 * Contains content directly and only stores final states (not streaming deltas).
 */
export interface StoredContent<TContent = unknown> {
  seq: number;
  timestamp: number;
  content: TContent;
}

export interface SessionInfo {
  sessionKey: string;
  userId: string;
  configId: string;
  status: SessionStatus;
  clientCount: number;
  contentSeq: number;
  oldestContentSeq: number;
  createdAt: string;
  remainingTtlMs: number;
  /** Voice engine the server advertises: 'realtime' = the /voice WS gateway; 'v0' = record-and-transcribe. */
  voiceEngine?: 'realtime' | 'v0';
}

export interface SessionJoinedParams {
  sessionKey: string;
  status: string;
  contentSeq: number;
}

export interface ContentResumeParams {
  afterSeq: number;
}

export interface ContentResumeResult<TContent = unknown> {
  contents: StoredContent<TContent>[];
  replayed: number;
  currentSeq: number;
  warning?: string;
  oldestAvailable?: number;
}

export type FinishSignalContent = {
  type: 'finish';
  messageId: 'finish';
  responseId?: string;
};

export type ErrorSignalContent = {
  type: 'error';
  messageId: 'error';
  responseId?: string;
  error: string;
};

export type AgentStreamContent<TContent = unknown> =
  | TContent
  | FinishSignalContent
  | ErrorSignalContent;

export type MemoryEntry = {
  id: string;
  summary: string;
  timestamp: number;
};

export const BROWSER_VOICE_SCREEN_TEXT_MAX_CHARS = 4_000;

/** What one browser voice attachment says is visible in its own page area. */
export type BrowserVoiceScreenSelection =
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'text'; text: string }
  | null;

/**
 * `screen` is optional only so a newer server can admit an older browser.
 * `greet` is the browser's own fact — whether this is the first voice open of
 * its page load; the first open greets even a conversation with history, later
 * opens stay silent. Absent on older browsers, which fall back to the legacy
 * rule (greet only when nothing has been said yet).
 */
export type BrowserVoiceActivateEvent = {
  type: 'voice.activate';
  screen?: BrowserVoiceScreenSelection;
  greet?: boolean;
};

/** Replaces the visible selection for one already-active browser voice attachment. */
export type BrowserVoiceScreenEvent = {
  type: 'voice.screen';
  screen: BrowserVoiceScreenSelection;
};
