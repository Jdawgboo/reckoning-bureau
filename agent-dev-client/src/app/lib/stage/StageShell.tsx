/**
 * Stage shell (`?stage=1`): "the generated surface IS the page" — one active
 * A2UI surface fills the page area, a turn rail on the left gives history
 * without a transcript, and the omnibox dock at the bottom carries the
 * narrator line, lazy chips, and the input.
 *
 * Platform-only: this file owns layout/chrome, theme mechanism, session
 * lifecycle, and navigator (jump/history) semantics. It never contains
 * business content — `brandName`/`navItems` are the template's data.
 *
 * Session lifecycle bootstraps identically to chat (`useMessagingService` +
 * `useChatRehydration`) so the welcome flow, rehydration, and agui
 * subscription all run through the same store path — no stage
 * special-casing.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { observer } from 'mobx-react-lite';
import { useIntl } from 'react-intl';
import { cn } from '@/app/lib/utils';
import { useMessagingStore, useChatRehydration } from '@/app/lib/hooks';
import { useMessagingService } from '@/app/lib/hooks/useMessagingService';
import { SurfaceRenderer } from '@/app/lib/a2ui/SurfaceRenderer.tsx';
import { buildTurnIndex } from './turn-index.ts';
import { formatTurnFragment, parseTurnFragment, resolveHistoryAction } from './turn-url.ts';
import { isRecord } from '../util/type-guards.ts';
import { StageHeader, type AgentHeaderProps } from './StageHeader.tsx';
import { resolveLoadingLine, type LoadingLine } from './loading-line.ts';
import { resolveErrorNotice } from './error-notice.ts';
import {
  isStageRunActive,
  resolveStageView,
  voiceScreenSelectionForStage,
  type StageView,
} from './stage-view.ts';
import { TranscriptPage } from './TranscriptPage.tsx';
import { TextPage } from './TextPage.tsx';
import { processPageFor } from './process/index.ts';
import { SurfaceHeader } from '@/app/lib/a2ui/blocks/SurfaceHeader.tsx';
import { TurnRail } from './TurnRail.tsx';
import { StageDock } from './StageDock.tsx';
import { VoiceReader } from '@/app/lib/components/input/VoiceReader';
import { AudioSender } from '@/app/lib/components/input/AudioSender';
import { RealtimeVoiceSession } from '@/app/lib/components/input/RealtimeVoiceSession';
import type { Attachment } from '@/app/lib/types/files';
import {
  decorateWithAttachments,
  splitAttachmentMarker,
} from '@/app/lib/files/attachment-marker.ts';
import { surfaceRendersSomething } from './surface-content.ts';
import { resolveNavItems, type LocalizedNavItem, type NavItem } from './nav-model.ts';
import { useA2uiDemoHook } from './demo-fixture.ts';
import './stage-effects.css';
import { useLocalization } from '@/app/lib/localization/LocalizationProvider.tsx';
import { messages } from '@/app/lib/localization/messages.ts';
import type { MessageDescriptor } from 'react-intl';
import {
  resolveLocalizationCover,
  sameLocalizationCoverTarget,
  type LocalizationCoverTarget,
} from './localization-cover.ts';
import { formatNarrationLine } from './narration-line.ts';

const GLIMM_SWEEP_MS = 600;
const MAX_CHIPS = 4;
const LOCALIZATION_DETAIL_DELAY_MS = 400;
/** One history entry per rail scrub — rapid selection changes coalesce. */
const TURN_URL_SYNC_DEBOUNCE_MS = 250;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/** Validated string array from `uiState./chips`, capped at `MAX_CHIPS`:
 *  lazy next-step labels, non-strings dropped. Before the agent's first
 *  `/chips` write, the template's baseline suggestions show instead — same
 *  baseline/overlay pattern as the nav. */
function resolveChips(uiStateChips: unknown, defaults: string[]): string[] {
  if (!Array.isArray(uiStateChips)) {
    return defaults.slice(0, MAX_CHIPS);
  }
  return uiStateChips
    .filter((chip): chip is string => typeof chip === 'string')
    .slice(0, MAX_CHIPS);
}

interface StageContent {
  /** Remount key — changes whenever what's on screen changes, driving both
   *  the surface-swap entrance animation and the glimm band sweep. */
  key: string;
  node: ReactNode;
}

/**
 * The one visual for the empty stage: a shimmering brand mark. An idle
 * stage with nothing renderable is not a designed product state — the
 * welcome turn (or restored content) must always arrive. If this is still
 * on screen after the run settles, that is a BUG to fix at its root (a
 * status lie, a restore gap), never a state to restyle into something calm.
 * `line` names what the wait actually is (connecting, preparing, working,
 * stuck) so a stalled load reads as a fixable state, not silence.
 */
const BrandArrival: FC<{
  brandName: string;
  line?: LoadingLine;
  retryLabel: string;
  onRetry?: () => void;
}> = ({ brandName, line, retryLabel, onRetry }) => (
  <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
    <span
      className="font-display text-3xl font-semibold tracking-tight shimmer-text motion-reduce:animate-none"
      translate="no"
    >
      {brandName}
    </span>
    {line ? (
      <div className="flex flex-row items-baseline justify-center gap-2">
        <span aria-live="polite" className="max-w-md overflow-hidden text-center">
          <span
            key={line.text}
            className="inline-block animate-in fade-in slide-in-from-bottom-2 duration-500 text-sm text-muted-foreground motion-reduce:animate-none"
          >
            {line.text}
          </span>
        </span>
        {'retry' in line && line.retry ? (
          <button
            type="button"
            onClick={onRetry}
            className="text-sm underline underline-offset-2 hover:text-foreground"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    ) : null}
  </div>
);

export interface StageShellProps {
  /** Template's business name — brand is template data, not stage-owned. */
  brandName?: string;
  /** Baseline standing-intent nav items; overlaid by `uiState./nav` when present. */
  navItems?: LocalizedNavItem[];
  /** Baseline next-step chips shown until the agent writes `uiState./chips`. */
  defaultChips?: MessageDescriptor[];
  /** Page-area mode: 'site' (surface IS the page) or 'chat' (transcript). */
  mode?: 'site' | 'chat';
  /** Site header slot. Default OFF: an unbranded agent renders the minimal
   *  canvas (rail + page + dock); a header is site identity the agent's
   *  config opts into. */
  showHeader?: boolean;
  /** Custom header component (agent zone); defaults to `StageHeader`. */
  Header?: FC<AgentHeaderProps>;
  /** Unused: `loading` always renders `BrandArrival` now (see that
   *  component's JSDoc) — this no longer gates the empty-stage visual.
   *  Left in place as public API. */
  brandedArrival?: boolean;
  /** Resolved to a `light`/`dark` class on the document root. */
  appearance?: 'light' | 'dark' | 'auto';
  /** Omnibox placeholder override. */
  placeholder?: MessageDescriptor;
}

export const StageShell: FC<StageShellProps> = observer(
  ({
    brandName,
    navItems = [],
    defaultChips = [],
    mode = 'site',
    showHeader = false,
    Header = StageHeader,
    appearance = 'light',
    placeholder,
  }) => {
    useMessagingService();
    const intl = useIntl();
    const localization = useLocalization();
    const displayBrandName = brandName ?? intl.formatMessage(messages.agentName);
    const messagesStore = useMessagingStore();
    const [initError, setInitError] = useState(false);
    const onInitError = useCallback(() => setInitError(true), []);
    const { isReady, connectionStatus } = useChatRehydration({ onError: onInitError });
    useA2uiDemoHook();

    const localizationTransition = localization.transition;
    const previousActivationVersion = useRef(localization.activationVersion);
    const previousMessageLocale = useRef(localization.messageLocale);
    const [heldLocalizationTarget, setHeldLocalizationTarget] =
      useState<LocalizationCoverTarget | null>(null);
    const voiceLocaleRunActive =
      messagesStore.voiceState === 'thinking' ||
      messagesStore.voiceState === 'building' ||
      messagesStore.voiceState === 'speaking';
    const localizationCoverResolution = resolveLocalizationCover({
      transition: localizationTransition,
      activeTarget: {
        messageLocale: localization.messageLocale,
        formatLocale: localization.formatLocale,
      },
      heldTarget: heldLocalizationTarget,
      localeActivationChanged:
        previousActivationVersion.current !== localization.activationVersion &&
        previousMessageLocale.current !== localization.messageLocale,
      runActive:
        messagesStore.userRequestPending || messagesStore.voiceRunBusy || voiceLocaleRunActive,
    });
    const localizationCoverTarget = localizationCoverResolution.visibleTarget;
    const localizationCoverKey = localizationCoverTarget?.formatLocale ?? null;
    useLayoutEffect(() => {
      previousActivationVersion.current = localization.activationVersion;
      previousMessageLocale.current = localization.messageLocale;
      setHeldLocalizationTarget((current) =>
        sameLocalizationCoverTarget(current, localizationCoverResolution.heldTarget)
          ? current
          : localizationCoverResolution.heldTarget,
      );
    }, [
      localization.activationVersion,
      localization.messageLocale,
      localizationCoverResolution.heldTarget,
    ]);
    const [detailedLocalizationKey, setDetailedLocalizationKey] = useState<string | null>(null);
    useEffect(() => {
      setDetailedLocalizationKey(null);
      if (!localizationCoverKey) {
        return;
      }
      const timeout = window.setTimeout(
        () => setDetailedLocalizationKey(localizationCoverKey),
        LOCALIZATION_DETAIL_DELAY_MS,
      );
      return () => window.clearTimeout(timeout);
    }, [localizationCoverKey]);

    const localizationCoverVisible = localizationCoverTarget !== null;
    const pageContainerRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const pageContainer = pageContainerRef.current;
      if (!pageContainer) {
        return;
      }
      if (localizationCoverVisible) {
        pageContainer.setAttribute('inert', '');
      } else {
        pageContainer.removeAttribute('inert');
      }
    }, [localizationCoverVisible]);

    let localizationNarration = '';
    if (localizationCoverTarget) {
      localizationNarration = intl.formatMessage(messages.thinking);
      if (detailedLocalizationKey === localizationCoverKey) {
        localizationNarration = intl.formatMessage(messages.localizationPreparing);
      }
    }

    // ONE theme signal: the agent's `appearance` becomes a light/dark class
    // on the document root; every palette (chat tokens, stage tokens, agent
    // theme overrides) keys off that class alone.
    useEffect(() => {
      const root = document.documentElement;
      const apply = (dark: boolean) => {
        root.classList.toggle('dark', dark);
        root.classList.toggle('light', !dark);
        const canvasColor = getComputedStyle(root).backgroundColor;
        const themeColorMeta = document.querySelector('meta[name="theme-color"]');
        if (canvasColor && themeColorMeta) {
          themeColorMeta.setAttribute('content', canvasColor);
        }
        // iOS 26 samples toolbar tint at initial render only; a display
        // round-trip re-enters the render tree and forces a fresh sample.
        const strip = document.getElementById('edge-tint');
        if (strip) {
          strip.style.display = 'none';
          strip.getBoundingClientRect();
          strip.style.display = '';
        }
      };
      if (appearance !== 'auto') {
        apply(appearance === 'dark');
        return;
      }
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      apply(media.matches);
      const onChange = (event: MediaQueryListEvent) => apply(event.matches);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }, [appearance]);

    const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
    // Optimistic echo: the request text, held locally from the moment of
    // send until the server echo creates the turn. Without it the shell
    // keeps resolving the PREVIOUS turn for a beat and the submitted text
    // appears nowhere.
    const [pendingRequest, setPendingRequest] = useState<string | null>(null);
    const [sweeping, setSweeping] = useState(false);
    const isFirstRender = useRef(true);

    const turns = useMemo(() => buildTurnIndex(messagesStore.contents), [messagesStore.contents]);

    // A new turn always pulls the view back to the live head. Without this,
    // a send made while a history selection is active leaves the view stuck
    // on the previously selected turn.
    const prevTurnCount = useRef(turns.length);
    useEffect(() => {
      if (turns.length > prevTurnCount.current) {
        setSelectedIndex(null);
        setPendingRequest(null);
      }
      prevTurnCount.current = turns.length;
    }, [turns.length]);

    // Safety valve: a failed/aborted send never leaves the echo pinned.
    const requestPending = messagesStore.userRequestPending;
    useEffect(() => {
      if (!requestPending) {
        setPendingRequest(null);
      }
    }, [requestPending]);

    const surfaceEntries = [...messagesStore.a2uiSurfaces.surfaces.entries()];

    const liveHeadIndex = turns.length - 1;
    const resolvedIndex = selectedIndex !== null ? selectedIndex : liveHeadIndex;
    const resolvedTurn = resolvedIndex >= 0 ? turns[resolvedIndex] : undefined;

    const atLiveHead = selectedIndex === null || selectedIndex === liveHeadIndex;
    const chatMode = mode === 'chat';

    const fromPopstateRef = useRef(false);
    const pendingRestoreRef = useRef<number | null>(
      typeof window === 'undefined' ? null : parseTurnFragment(window.location.hash),
    );
    const urlSyncTimerRef = useRef<number | undefined>(undefined);

    useEffect(() => {
      if (chatMode || pendingRestoreRef.current === null) {
        return;
      }
      if (turns.length > pendingRestoreRef.current) {
        const target = pendingRestoreRef.current;
        pendingRestoreRef.current = null;
        fromPopstateRef.current = true;
        setSelectedIndex(target === turns.length - 1 ? null : target);
      }
    }, [chatMode, turns.length]);

    useEffect(() => {
      if (chatMode || turns.length === 0 || pendingRestoreRef.current !== null) {
        return;
      }
      window.clearTimeout(urlSyncTimerRef.current);
      urlSyncTimerRef.current = window.setTimeout(() => {
        const state: unknown = window.history.state;
        const urlIndex =
          isRecord(state) && typeof state['turn'] === 'number' ? state['turn'] : undefined;
        const action = resolveHistoryAction({
          urlIndex,
          shownIndex: resolvedIndex,
          fromPopstate: fromPopstateRef.current,
        });
        fromPopstateRef.current = false;
        if (action === 'none') {
          return;
        }
        const url =
          window.location.pathname + window.location.search + formatTurnFragment(resolvedIndex);
        if (action === 'replace') {
          window.history.replaceState({ turn: resolvedIndex }, '', url);
        } else {
          window.history.pushState({ turn: resolvedIndex }, '', url);
        }
      }, TURN_URL_SYNC_DEBOUNCE_MS);
      return () => window.clearTimeout(urlSyncTimerRef.current);
    }, [chatMode, turns.length, resolvedIndex]);

    useEffect(() => {
      if (chatMode) {
        return;
      }
      const onPopstate = (event: PopStateEvent) => {
        const state: unknown = event.state;
        if (!isRecord(state) || typeof state['turn'] !== 'number') {
          return;
        }
        pendingRestoreRef.current = null;
        const clamped = Math.min(Math.max(state['turn'], 0), turns.length - 1);
        fromPopstateRef.current = true;
        setSelectedIndex(clamped === turns.length - 1 ? null : clamped);
      };
      window.addEventListener('popstate', onPopstate);
      return () => window.removeEventListener('popstate', onPopstate);
    }, [chatMode, turns.length]);

    const activePart = messagesStore.activeProcessPart;
    const processPartKey =
      activePart && processPageFor(activePart.componentName)
        ? (activePart.streaming?.toolCallId ?? activePart.messageId ?? 'live')
        : null;

    // All page-area rules live in the pure resolver (stage-view.ts) — the
    // shell only maps the returned descriptor to JSX. `prevLive` is updated
    // at the live head only: a history detour must not become the held page.
    const prevLiveRef = useRef<StageView | null>(null);
    const view = resolveStageView(
      {
        turns,
        selectedIndex,
        surfaces: surfaceEntries.map(([id, surface]) => ({
          id,
          responseId: surface.responseId,
          lastTouchedResponseId: surface.lastTouchedResponseId,
          hasContent: surfaceRendersSomething(surface),
        })),
        processPartKey,
        userRequestPending: messagesStore.userRequestPending,
        voiceRunActive: messagesStore.speechEnabled && messagesStore.voiceRunBusy,
      },
      prevLiveRef.current,
    );
    if (atLiveHead) {
      prevLiveRef.current = view;
    }

    // `runInFlight` (declared later, for the dock echo) is the same signal as
    // `messagesStore.userRequestPending` — read it directly here rather than
    // reordering the section below it exists in. Same for the voice facts
    // (`voiceActive`/`voiceRunBusy`, declared later): a voice-forwarded run
    // never sets `userRequestPending` (MessagesStore, by design), so without
    // this exclusion a live voice turn reads as `settledEmpty` and the
    // resolver returns 'stuck' while the agent is still speaking.
    const narrationLine = formatNarrationLine(messagesStore.narration.line, intl);
    const loadingLine =
      view.kind === 'loading'
        ? resolveLoadingLine(
            {
              connectionStatus,
              isReady,
              initError,
              runInFlight: messagesStore.userRequestPending,
              narrationLine,
              settledEmpty:
                !messagesStore.userRequestPending &&
                isReady &&
                !messagesStore.speechEnabled &&
                !messagesStore.voiceRunBusy,
              terminalText: messagesStore.lastRunError?.message ?? null,
            },
            {
              couldNotConnect: intl.formatMessage(messages.couldNotConnect),
              connecting: intl.formatMessage(messages.connecting),
              gettingReady: intl.formatMessage(messages.gettingReady),
              thinking: intl.formatMessage(messages.thinking),
              pageLoadFailed: intl.formatMessage(messages.pageLoadFailed),
            },
          )
        : null;

    const [dismissedErrorRunId, setDismissedErrorRunId] = useState<string | null>(null);
    const liveHeadTurn = turns[liveHeadIndex];
    const errorNotice = resolveErrorNotice({
      viewKind: view.kind,
      lastRunError: messagesStore.lastRunError,
      liveTurn: liveHeadTurn
        ? { responseId: liveHeadTurn.responseId, responseText: liveHeadTurn.responseText }
        : undefined,
    });

    const viewingHistory = mode !== 'chat' && !atLiveHead && resolvedTurn !== undefined;
    const currentRailIndex = viewingHistory ? resolvedIndex : liveHeadIndex;
    const voiceScreenSelection = voiceScreenSelectionForStage({
      view,
      turns,
      chatMode,
      processNarration: narrationLine,
      copy: {
        transcriptOpen: intl.formatMessage(messages.transcriptOpen),
        workInProgress: intl.formatMessage(messages.workInProgress),
        screenTextTruncated: intl.formatMessage(messages.screenTextTruncated),
      },
    });

    const stageContent: StageContent = (() => {
      // Chat mode: the transcript IS the page — constant key, so the sweep
      // never fires and history semantics don't apply.
      if (chatMode) {
        return { key: 'transcript', node: <TranscriptPage /> };
      }
      switch (view.kind) {
        case 'surface': {
          return { key: view.key, node: <SurfaceRenderer surfaceId={view.surfaceId} /> };
        }
        case 'process': {
          const ProcessPage = activePart ? processPageFor(activePart.componentName) : undefined;
          const request = turns[view.turnIndex]?.request;
          return {
            key: view.key,
            node: (
              <>
                {request ? <SurfaceHeader title={request} /> : null}
                {ProcessPage && activePart ? <ProcessPage part={activePart} /> : null}
              </>
            ),
          };
        }
        case 'text': {
          const textTurn = turns[view.turnIndex];
          const isErrorTurn =
            messagesStore.lastRunError !== null &&
            textTurn?.responseId === messagesStore.lastRunError.responseId;
          if (isErrorTurn) {
            return {
              key: view.key,
              node: (
                <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
                  <span className="font-display text-3xl font-semibold tracking-tight text-muted-foreground">
                    {displayBrandName}
                  </span>
                  <p className="max-w-md text-sm text-muted-foreground">{textTurn.responseText}</p>
                </div>
              ),
            };
          }
          return { key: view.key, node: <TextPage turn={textTurn} /> };
        }
        case 'loading':
          return {
            key: view.key,
            node: (
              <BrandArrival
                brandName={displayBrandName}
                line={loadingLine ?? undefined}
                retryLabel={intl.formatMessage(messages.retry)}
                onRetry={() => window.location.reload()}
              />
            ),
          };
      }
    })();

    // Glimm band sweep on page swap — see stage-effects.css .stage-glimmband.
    // Note: the `glimm` npm package is unrelated (a fullscreen multi-hue
    // WebGL overlay); this is a scoped single-accent CSS band, not that
    // library.
    // biome-ignore lint/correctness/useExhaustiveDependencies: stageContent.key is a trigger-only dep — the effect re-runs the sweep on identity change without reading the value.
    useEffect(() => {
      if (isFirstRender.current) {
        isFirstRender.current = false;
        return;
      }
      if (prefersReducedMotion()) {
        return;
      }
      setSweeping(true);
      const timeoutId = window.setTimeout(() => setSweeping(false), GLIMM_SWEEP_MS);
      return () => window.clearTimeout(timeoutId);
    }, [stageContent.key]);

    const localizedNavItems = navItems.map((item) => ({
      label: intl.formatMessage(item.label),
      intent: intl.formatMessage(item.intent),
      active: item.active,
    }));
    const localizedDefaultChips = defaultChips.map((chip) => intl.formatMessage(chip));
    const resolvedPlaceholder = placeholder ? intl.formatMessage(placeholder) : undefined;
    const resolvedNavItems = resolveNavItems(messagesStore.uiState.get('/nav'), localizedNavItems);
    const chips = resolveChips(messagesStore.uiState.get('/chips'), localizedDefaultChips);

    // Page content and run completion are separate signals. The first complete
    // SectionStack child may own the page while later children are still
    // streaming, so only the run terminal may clear the progress track, stop
    // control, request echo, and working narration.
    const liveTurn = turns[turns.length - 1];
    const runInFlight = isStageRunActive(messagesStore.userRequestPending);

    // The persistent slot carries STATUS, never the model's prose. Voice
    // session active → the live caption / Muted / Listening; a run working with
    // nothing on the page yet → the friendly status phrase; else chips.
    const voiceActive = messagesStore.speechEnabled;
    const guideMode: 'voice' | 'chips' = runInFlight || voiceActive ? 'voice' : 'chips';
    let narration = '';
    let voiceStatusWord = '';
    if (messagesStore.voiceState === 'connecting') {
      voiceStatusWord = intl.formatMessage(messages.voiceConnecting);
    } else if (messagesStore.voiceState === 'thinking' || messagesStore.voiceState === 'building') {
      voiceStatusWord = intl.formatMessage(messages.voiceThinking);
    }
    const voiceRunWorking = voiceActive && messagesStore.voiceRunBusy;
    const voiceThinking = voiceActive && (voiceStatusWord !== '' || voiceRunWorking);
    if (voiceRunWorking) {
      narration = narrationLine || voiceStatusWord;
    } else if (voiceActive) {
      narration = voiceStatusWord || messagesStore.voiceCaption;
    } else if (runInFlight) {
      narration = narrationLine;
    }
    // The dock pill's echo: optimistic text until the echo lands, then the
    // live turn's request while the run is in flight.
    const rawEcho = runInFlight
      ? (pendingRequest ?? (liveTurn && !liveTurn.home ? liveTurn.request : null))
      : null;
    const requestEcho = rawEcho === null ? null : splitAttachmentMarker(rawEcho).text;

    /** Same attachment convention as the chat shell: surface filenames inline
     *  in the user turn so they survive history rehydration; the model gets
     *  the actual file content alongside via `files`. */
    const echoAndSend = (text: string) => {
      pendingRestoreRef.current = null;
      setPendingRequest(text);
      messagesStore.sendMessage({ instruction: text });
    };

    const handleSend = (text: string, files?: Attachment[]) => {
      const hasFiles = !!files && files.length > 0;
      const decoratedText = hasFiles
        ? decorateWithAttachments(
            text,
            files.map((f) => f.name),
          )
        : text;
      if (hasFiles) {
        messagesStore.rememberSentAttachments(decoratedText, files);
      }
      pendingRestoreRef.current = null;
      setPendingRequest(decoratedText);
      messagesStore.sendMessage({
        instruction: decoratedText,
        ...(hasFiles ? { files } : {}),
      });
    };

    const handleChipSelect = (chip: string) => {
      echoAndSend(chip);
    };

    // The document keeps scroll position across page remounts (the old inner
    // scroller reset implicitly by being recreated). Chat mode's constant key
    // never triggers this — transcript continuity preserved.
    const pageKey = stageContent.key;
    useEffect(() => {
      if (pageKey !== 'transcript') {
        window.scrollTo(0, 0);
      }
    }, [pageKey]);

    /** Nav acts on the live head, never on history: clicking nav while
     *  viewing a past turn starts a new turn and jumps the view back to the
     *  live head. */
    const handleNavClick = (item: NavItem) => {
      setSelectedIndex(null);
      echoAndSend(item.intent);
    };

    return (
      <div
        className="stage relative flex min-h-dvh flex-col bg-background text-foreground"
        aria-busy={localizationCoverVisible}
      >
        <VoiceReader />
        <AudioSender
          onRecord={(base64Audio) => messagesStore.sendMessage({ audio: base64Audio })}
        />
        <RealtimeVoiceSession screenSelection={voiceScreenSelection} />
        {!localizationCoverVisible ? (
          <TurnRail
            turns={turns}
            currentIndex={currentRailIndex}
            onSelect={(index) => {
              if (chatMode) {
                document
                  .getElementById(`turn-${index}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
              }
              pendingRestoreRef.current = null;
              setSelectedIndex(index);
            }}
          />
        ) : null}

        {/* Headers own their full-width bar and center their own content row to
            the page column (see StageHeader) — the shell mounts them bare so a
            custom header can style the full bar (border, ground, blur) and
            bring its own mobile menu treatment. */}
        {showHeader && !localizationCoverVisible && (
          <div className="sticky top-0 z-[5]">
            <Header
              brandName={displayBrandName}
              navItems={resolvedNavItems}
              onNavigate={handleNavClick}
            />
          </div>
        )}

        <div
          ref={pageContainerRef}
          className="relative flex-1"
          aria-hidden={localizationCoverVisible}
        >
          <div className="px-5 pb-48 pt-8 md:px-20" data-stage-page>
            <div
              className={cn(
                'mx-auto',
                chatMode ? 'max-w-container-form' : 'max-w-container-content',
              )}
            >
              <div key={stageContent.key} className="animate-fadeUp">
                {stageContent.node}
              </div>
            </div>
          </div>
          <div
            className="stage-glimmband pointer-events-none fixed inset-0 z-[3] opacity-0 data-[running=true]:opacity-100"
            data-running={sweeping}
          />
        </div>

        {!localizationCoverVisible &&
        errorNotice &&
        messagesStore.lastRunError?.responseId !== dismissedErrorRunId ? (
          <div className="pointer-events-none fixed inset-x-0 bottom-28 z-[6] flex justify-center px-5">
            <div
              aria-live="polite"
              className="pointer-events-auto flex max-w-container-form items-start gap-3 rounded-xl border border-destructive/30 bg-background/95 px-4 py-3 text-sm text-foreground shadow-lg backdrop-blur"
            >
              <span>{errorNotice}</span>
              <button
                type="button"
                aria-label={intl.formatMessage(messages.dismiss)}
                onClick={() =>
                  setDismissedErrorRunId(messagesStore.lastRunError?.responseId ?? null)
                }
                className="text-muted-foreground hover:text-foreground"
              >
                &times;
              </button>
            </div>
          </div>
        ) : null}
        {!localizationCoverVisible ? (
          <StageDock
            guideMode={guideMode}
            voiceActive={voiceActive}
            placeholder={resolvedPlaceholder}
            requestEcho={requestEcho}
            narration={view.kind === 'loading' && !voiceActive ? '' : narration}
            narrationVariant={voiceActive && !voiceThinking ? 'caption' : 'status'}
            chips={chips}
            onChipSelect={handleChipSelect}
            isUserRequestPending={runInFlight}
            onSend={handleSend}
            onStopStreaming={messagesStore.stopStreaming}
          />
        ) : null}
        {localizationCoverVisible ? (
          <div className="fixed inset-0 z-50 flex min-h-dvh items-center justify-center bg-background px-5">
            <BrandArrival
              brandName={displayBrandName}
              line={{ kind: 'working', text: localizationNarration }}
              retryLabel={intl.formatMessage(messages.retry)}
            />
          </div>
        ) : null}
      </div>
    );
  },
);
