/**
 * Reconnect ledger seeding: the conversation ledger a `VoiceContextProjector`
 * builds is a derived view over `TurnEvent`s, so the seed for a reconnected
 * voice session IS the projector replayed over stored history — no separate
 * seed format. Groups the session's stored contents by `responseId`, feeds
 * each of the last `MAX_SEED_RUNS` runs through a fresh `TurnObserver` (same
 * detector, same projector), and resolves each run's outcome synchronously so
 * every seed line lands before the caller regains control.
 */
import { ContentType, type AgentContent } from '../bl/agent/agent-library.ts';
import {
  TurnObserver,
  type UIRenderDetector,
} from '../../vendor/agentplace-voice/turn-observer.ts';
import type { TurnEvent } from '../../vendor/agentplace-voice/turn-events.ts';
import type { StoredContent } from './agent-session.types.ts';

const MAX_SEED_RUNS = 8;

/** The `VoiceContextProjector` surface seeding needs — structural so this
 *  module stays a pure function, testable without a live projector or socket. */
export interface SeedLedgerProjector {
  onEvent(runId: string, event: TurnEvent, requestText: string | null): void;
  noteRelayOutcome(runId: string, outcome: 'full' | 'partial'): void;
}

/** How much of stored history actually made it into the ledger — logged by
 *  the caller so a session that seeds zero surfaces after real UI work is
 *  visible instead of silently starting the voice model blind. */
export interface SeedLedgerSummary {
  runs: number;
  surfaces: number;
}

/**
 * Replays the last `MAX_SEED_RUNS` runs (grouped by `responseId`, oldest
 * first) into `projector`. Each run gets its own `TurnObserver`; the run's
 * user-message text (when present) becomes its `requestText`, mirroring the
 * live narration tap. After a run's `observer.complete()`, the outcome is
 * resolved immediately as `'full'` — a parked spoken-answer line flushes
 * synchronously instead of waiting on the projector's park timeout, so no
 * timer is left pending once this function returns. A no-op run (nothing to
 * deliver) simply writes nothing, same as it would live.
 */
export function seedLedgerFromHistory(params: {
  contents: StoredContent[];
  projector: SeedLedgerProjector;
  detector: UIRenderDetector;
}): SeedLedgerSummary {
  const { contents, projector, detector } = params;
  const runsById = projectableRunsByResponseId(contents);
  const runIds = [...runsById.keys()].slice(-MAX_SEED_RUNS);
  if (runIds.length === 0) {
    return { runs: 0, surfaces: 0 };
  }
  let runs = 0;
  let surfaces = 0;
  for (const runId of runIds) {
    const items = runsById.get(runId);
    if (!items) {
      continue;
    }
    surfaces += replayRun({ runId, items, projector, detector });
    runs += 1;
  }
  return { runs, surfaces };
}

/**
 * Groups only ordinary agent runs. Voice delivery evidence is replayed
 * separately as exact user/assistant dialogue by `VoiceGateway`; treating it
 * as an agent run would duplicate speech and displace real runs from the cap.
 */
function projectableRunsByResponseId(contents: StoredContent[]): Map<string, AgentContent[]> {
  const grouped = new Map<string, AgentContent[]>();
  for (const item of contents) {
    const responseId = item.content.responseId;
    if (!responseId) {
      continue;
    }
    const group = grouped.get(responseId);
    if (group) {
      group.push(item.content);
    } else {
      grouped.set(responseId, [item.content]);
    }
  }
  const projectable = new Map<string, AgentContent[]>();
  for (const [responseId, items] of grouped) {
    const agentItems = items.filter((content) => content.voiceDelivery === undefined);
    const hasAgentOutput = agentItems.some(
      (content) => !(content.type === ContentType.Text && content.role === 'user'),
    );
    if (!hasAgentOutput) {
      continue;
    }
    projectable.set(responseId, agentItems);
  }
  return projectable;
}

/** Replays one run into `projector`; returns the number of `ui-rendered`
 *  events seen, for the caller's seed summary. */
function replayRun(params: {
  runId: string;
  items: AgentContent[];
  projector: SeedLedgerProjector;
  detector: UIRenderDetector;
}): number {
  const { runId, items, projector, detector } = params;
  const requestText = requestTextOf(items);
  let surfaces = 0;
  const observer = new TurnObserver({
    runId,
    detector,
    emit: (event) => {
      if (event.type === 'ui-rendered') {
        surfaces += 1;
      }
      projector.onEvent(runId, event, requestText);
    },
  });
  for (const item of items) {
    observer.handle(item);
  }
  observer.complete();
  projector.noteRelayOutcome(runId, 'full');
  return surfaces;
}

/** The run's own request — its user-role TXT content, trimmed. `null` when
 *  the run has none (e.g. a screen-originated run), read downstream as
 *  "visitor asked (on screen)". */
function requestTextOf(items: AgentContent[]): string | null {
  for (const item of items) {
    if (item.type === ContentType.Text && item.role === 'user' && item.hidden !== true) {
      const text = item.content.trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}
