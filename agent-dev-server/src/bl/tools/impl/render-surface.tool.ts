/**
 * Generic surface-tool factory: contract-agnostic platform code. One `Render<Component>`
 * tool is generated per `ComponentContract` supplied via `src/surfaces/index.ts` — the
 * schema, validation, event emission, and dataModel seeding all derive from the contract.
 * This file never names a component; the model-facing purpose line is the contract's own.
 */
import { isDeepStrictEqual } from 'node:util';
import { jsonSchema } from '@ai-sdk/provider-utils';
import {
  ToolModel,
  type StateTree,
  type ToolExecuteContext,
  type ToolExecuteResult,
  type ToolParameters,
  type AgentState,
} from '../../agent/agent-library.ts';
import { getSessionKey, type DevServerAppState } from '../../agent/agent-state.ts';
import { isRecord } from '../../../util/type-guards.ts';
import { log } from '../../../util/logger.ts';
import {
  contractToFlatToolSchema,
  resolvePendingAction,
  type ComponentContract,
  type FallbackLocalization,
} from '../../../../vendor/agentplace-a2ui/contract-schema.ts';
import type { A2uiComponentNode } from '../../../../vendor/agentplace-a2ui/types.ts';
import { settledStringProp } from '../../../../vendor/agentplace-a2ui/partial-input.ts';
import { contractHoldsVisitorState } from '../../builtin-catalog/assemble-surface-contracts.ts';
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';
import {
  buildSurfaceEvents,
  mergeSeedIntoUiState,
  decodeRecordStrings,
  splitToolInput,
} from './render-surface.helpers.ts';
import type { SurfaceSnapshot } from '../../../types.ts';

const EMPTY_SURFACE_SNAPSHOT: SurfaceSnapshot = { isPopulated: false, sections: [] };

interface SurfaceStreamProgress {
  surfaceId: string;
  snapshot: SurfaceSnapshot;
  createdSurface: boolean;
  lastEmittedNodes: A2uiComponentNode[] | null;
  /** At least one emission carried a settled node, not just the empty frame. */
  emittedSettledContent: boolean;
}

/**
 * Did an emission put anything on the screen, or only the frame? The opening
 * tick composes a bare root with no children — a skeleton the visitor reads as
 * "still loading," not as content that streamed.
 */
function carriesSettledContent(nodes: readonly A2uiComponentNode[]): boolean {
  if (nodes.length > 1) {
    return true;
  }
  const root = nodes[0];
  if (!root) {
    return false;
  }
  return Object.keys(root).some((key) => key !== 'id' && key !== 'component' && key !== 'children');
}

function buildToolDescription(contract: ComponentContract): string {
  return (
    `Render the ${contract.component} screen the visitor sees. ${contract.purpose} ` +
    `The screen carries its own content — don't repeat its contents back in prose. ` +
    `Write response-specific display props in the committed session language. Stable labels, ` +
    `menus, placeholders, validation, and accessibility wording remain catalog-owned. ` +
    `Fill props ONLY from real data (business facts, tool results, the visitor's own inputs). ` +
    `Re-use the same surfaceId to update a screen in place — input the visitor already entered is ` +
    `carried forward, so re-rendering does not discard it.`
  );
}

export interface SurfaceToolParams {
  contract: ComponentContract;
  catalogId: string;
  stateTree?: StateTree | null;
  sessionKey?: string;
  /** Structural state before this render first touches its target. Absent
   *  when the caller has no live screen source. */
  getSurfaceSnapshot?: (surfaceId: string) => SurfaceSnapshot;
  /** The catalog this tool's contract belongs to — used to read each on-screen
   *  section's `publishes` declaration. */
  catalogContracts?: Record<string, ComponentContract>;
  localization?: FallbackLocalization;
}

/**
 * Generated per contract by `createSurfaceTools`.
 *
 * `isStreaming: true` so the progressive-render path sees partial input while
 * the screen is still being written. Those partial emissions carry no display
 * value — the stage renders from the A2UI surface store, and the client drops
 * non-terminal `Surface` content.
 *
 * `execute()`'s `uiProps.surfaceReplay` carries the same AG-UI custom events
 * (`built.events`) already emitted live onto the run's event stream. It rides
 * `uiProps` into `ContentCapture` and CONTENT# alongside every other tool
 * result, so a session recreated after a restart can replay the screen
 * verbatim from CONTENT# without re-running contracts. The client never
 * reads this field — surfaces render from the live event stream.
 */
export class SurfaceTool extends ToolModel<Record<string, unknown>> {
  readonly #contract: ComponentContract;
  readonly #catalogId: string;
  readonly #stateTree: StateTree | null;
  readonly #sessionKey: string | undefined;
  readonly #getSurfaceSnapshot: ((surfaceId: string) => SurfaceSnapshot) | undefined;
  readonly #catalogContracts: Record<string, ComponentContract> | undefined;
  readonly #localization: FallbackLocalization | undefined;
  /** Per-toolCallId progressive-render state — see `streamPartialInput`. */
  readonly #progress = new Map<string, SurfaceStreamProgress>();

  constructor(params: SurfaceToolParams) {
    super({
      name: `Render${params.contract.component}`,
      description: buildToolDescription(params.contract),
      parametersSchema: jsonSchema(contractToFlatToolSchema(params.contract)) as ToolParameters,
      toolType: 'function',
      isStrict: false,
      audience: 'visitor',
      isStreaming: true,
    });
    this.#contract = params.contract;
    this.#catalogId = params.catalogId;
    this.#stateTree = params.stateTree ?? null;
    this.#sessionKey = params.sessionKey;
    this.#getSurfaceSnapshot = params.getSurfaceSnapshot;
    this.#catalogContracts = params.catalogContracts;
    this.#localization = params.localization;
    // A contract with no progressive composition can never emit from the hook —
    // tell the kernel so it skips parsing this tool's input deltas altogether.
    this.wantsPartialInput = params.contract.composePartial != null;
  }

  /** Surface tools are UI tools: the emitted tool part is the transcript's
   *  POSITION ANCHOR for the surface (rendered where the tool ran), and it
   *  persists through reconstruction. Without it, plain ToolModels emit no
   *  content and inline placement is impossible. */
  getComponentName(): string {
    return 'Surface';
  }

  /**
   * Progressive render, called during input streaming with the
   * best-effort-parsed accumulated tool input. No-ops unless the contract
   * defines `composePartial` (only `SectionStack` does today) — a plain
   * single-component contract has no structural notion of "one element
   * complete, the rest still writing," so guessing at one here risks
   * showing a broken partial component (missing required props). Doing
   * nothing for that case is the safe choice; `execute()` still renders it
   * atomically as it does today.
   *
   * `createSurface` is emitted exactly once per toolCallId; every later call in
   * this method emits `updateComponents` only.
   *
   * Skipped entirely when the target surface already holds content. Progressive
   * rendering opens by stripping the surface to `root` plus one dangling child
   * and rebuilds it section by section — right for a screen being built from
   * nothing, wrong for one already up, where every section would vanish and
   * return and the visitor would see the whole page refresh. A re-render goes
   * straight to `execute()`'s authoritative pair.
   */
  streamPartialInput(
    partial: unknown,
    emit: (name: string, value: unknown) => void,
    ctx: { toolCallId: string },
  ): void {
    const composePartial = this.#contract.composePartial;
    if (!composePartial || !isRecord(partial)) {
      return;
    }
    // A partial parse shows `surfaceId` as a growing prefix, so the raw value is
    // unusable: latching 'men' out of 'menu-board-1' would strand every later tick
    // against a surface the visitor never sees. Only the settled value is a target.
    const surfaceId = settledStringProp(partial, 'surfaceId');
    if (!surfaceId) {
      return;
    }

    const progress = this.#progressFor(ctx.toolCallId, surfaceId);
    if (progress.surfaceId !== surfaceId || progress.snapshot.isPopulated) {
      return;
    }

    const { nodes } = composePartial(decodeRecordStrings(partial));

    if (!progress.createdSurface) {
      emit(A2UI_EVENT_NAMES.createSurface, {
        surfaceId,
        catalogId: this.#catalogId,
        fallbackMarkdown: '',
      });
      progress.createdSurface = true;
    } else if (isDeepStrictEqual(nodes, progress.lastEmittedNodes)) {
      return;
    }
    progress.lastEmittedNodes = nodes;
    if (carriesSettledContent(nodes)) {
      progress.emittedSettledContent = true;
    }
    emit(A2UI_EVENT_NAMES.updateComponents, { surfaceId, components: nodes });
  }

  #progressFor(toolCallId: string, surfaceId: string): SurfaceStreamProgress {
    const existing = this.#progress.get(toolCallId);
    if (existing) {
      return existing;
    }
    const created: SurfaceStreamProgress = {
      surfaceId,
      snapshot: this.#snapshotFor(surfaceId),
      createdSurface: false,
      lastEmittedNodes: null,
      emittedSettledContent: false,
    };
    this.#progress.set(toolCallId, created);
    return created;
  }

  #snapshotFor(surfaceId: string): SurfaceSnapshot {
    return this.#getSurfaceSnapshot?.(surfaceId) ?? EMPTY_SURFACE_SNAPSHOT;
  }

  /**
   * Why `execute()`'s render did or did not stream progressively — attached to the
   * `surface.rendered` log so a builder can tell "platform declined to stream" apart
   * from "my contract is wrong."
   *
   * Reads `progress.snapshot` (the snapshot captured before streaming began) rather
   * than a fresh `#snapshotFor(surfaceId)` call: by the time `execute()` runs, the
   * live snapshot may already reflect this same call's own streamed emissions, which
   * would misreport a fresh stream as "already populated."
   *
   * `progress.surfaceId === surfaceId` is required before crediting 'streamed': a
   * provisional stream for one surfaceId (later abandoned, e.g. the model changes its
   * mind mid-call) must not be reported as this render's own outcome once `execute()`
   * lands on a different, final surfaceId — that surface never itself streamed.
   *
   * Creating the surface is not itself streaming: the opening tick emits an empty
   * frame, which the visitor reads as a loading skeleton. 'streamed' is credited only
   * once a settled node reached the screen ahead of `execute()`; a run that never got
   * past the frame reports 'skipped:frame-only'.
   */
  #progressiveOutcome(
    progress: SurfaceStreamProgress | undefined,
    surfaceId: string,
    snapshot: SurfaceSnapshot,
  ):
    | 'not-progressive'
    | 'streamed'
    | 'skipped:populated-surface'
    | 'skipped:frame-only'
    | 'skipped:no-ticks' {
    if (!this.#contract.composePartial) {
      return 'not-progressive';
    }
    const ownStream = progress?.surfaceId === surfaceId ? progress : undefined;
    if (ownStream?.emittedSettledContent) {
      return 'streamed';
    }
    if (snapshot.isPopulated) {
      return 'skipped:populated-surface';
    }
    return ownStream?.createdSurface ? 'skipped:frame-only' : 'skipped:no-ticks';
  }

  #discardProgressiveSurface(
    progress: SurfaceStreamProgress | undefined,
    emitCustomEvent: ToolExecuteContext['emitCustomEvent'],
  ): void {
    if (!progress?.createdSurface || !emitCustomEvent) {
      return;
    }
    emitCustomEvent(A2UI_EVENT_NAMES.deleteSurface, { surfaceId: progress.surfaceId });
  }

  /**
   * Which of the sections captured before this render are worth carrying into its
   * render. "Worth" is read from each section's contract `publishes`
   * declaration — never inferred from prop shape, or a component that takes
   * input some other way (a slider, a date picker) is silently dropped and the
   * visitor loses what they entered with no error anywhere.
   *
   * The decision lives here because this layer holds the catalog; the session
   * only reports what was on screen.
   */
  #carryForwardFor(onScreen: readonly unknown[]): unknown[] | null {
    if (onScreen.length === 0) {
      return null;
    }
    const contracts = this.#catalogContracts;
    if (!contracts) {
      return null;
    }
    const preserved = onScreen.filter((section) => {
      if (!isRecord(section) || typeof section.component !== 'string') {
        return false;
      }
      const contract = contracts[section.component];
      return contract !== undefined && contractHoldsVisitorState(contract);
    });
    return preserved.length > 0 ? preserved : null;
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ): Promise<ToolExecuteResult> {
    const { surfaceId, props, dataModel, chips } = splitToolInput(this.#contract, input);
    const progress = this.#progress.get(ctx.toolCallId);
    const snapshot =
      progress?.surfaceId === surfaceId ? progress.snapshot : this.#snapshotFor(surfaceId);
    const progressive = this.#progressiveOutcome(progress, surfaceId, snapshot);
    this.#progress.delete(ctx.toolCallId);

    let built: ReturnType<typeof buildSurfaceEvents>;
    try {
      built = buildSurfaceEvents({
        surfaceId,
        contract: this.#contract,
        catalogId: this.#catalogId,
        props,
        carryForward: this.#carryForwardFor(snapshot.sections),
        localization: this.#localization,
      });
    } catch (error) {
      this.#discardProgressiveSurface(progress, ctx.emitCustomEvent);
      throw error;
    }

    if (built.ok === false) {
      this.#discardProgressiveSurface(progress, ctx.emitCustomEvent);
      return { output: built.error };
    }

    if (!ctx.emitCustomEvent) {
      return {
        output: `${this.name} is unavailable in this run: the runtime does not support emitting AG-UI custom events.`,
      };
    }

    if (progress && progress.surfaceId !== surfaceId) {
      this.#discardProgressiveSurface(progress, ctx.emitCustomEvent);
    }

    for (const event of built.events) {
      ctx.emitCustomEvent(event.name, event.value);
    }

    // The moment the screen leaves the runtime. Paired with `message.start`, this is the only
    // record of how long a visitor waited before seeing anything — a slow screen and a fast one
    // are indistinguishable in a screenshot.
    log('info', {
      event: 'surface.rendered',
      component: this.#contract.component,
      surfaceId,
      toolCallId: ctx.toolCallId,
      progressive,
    });

    // The explicit chips param folds into the seed as a root pointer, alongside
    // the dataModel pointer convention.
    const seed: Record<string, unknown> = {
      ...(dataModel ?? {}),
      ...(chips ? { '/chips': chips } : {}),
    };
    if (Object.keys(seed).length > 0) {
      await this.#seedSurfaceDataModel(ctx, surfaceId, seed);
    }

    // The projection travels on the content anchor (fallbackMarkdown below),
    // never in this model-visible output.
    const hasLiveViewer = (ctx.sessionType ?? 'web') === 'web';
    let output: string;
    if (hasLiveViewer) {
      output = `${this.#contract.component} is now the current screen the visitor sees (surface ${surfaceId}).`;
    } else {
      output = `${this.#contract.component} rendered on surface ${surfaceId}. No live viewer on this channel — the screen's markdown fallback is the delivered form.`;
    }
    const pendingAction = resolvePendingAction(this.#contract, props);
    return {
      output,
      uiProps: {
        surfaceId,
        component: this.#contract.component,
        surfaceReplay: built.events,
        ...(pendingAction ? { pendingAction } : {}),
      },
      fallbackMarkdown: built.fallbackMarkdown,
    };
  }

  async #seedSurfaceDataModel(
    ctx: ToolExecuteContext,
    surfaceId: string,
    dataModel: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#stateTree) {
      return;
    }
    const agentState = ctx.runner.state as AgentState<unknown, DevServerAppState>;
    const sessionKey = getSessionKey(agentState) ?? this.#sessionKey;
    if (!sessionKey) {
      return;
    }
    const path = `/sessions/${sessionKey}/uiState`;
    const current = await this.#stateTree.get<Record<string, unknown>>(path);
    await this.#stateTree.set(path, mergeSeedIntoUiState(current, surfaceId, dataModel));
  }
}

/** One tool per supplied contract. The contract set is the AGENT's
 *  (`src/surfaces/index.ts`) — adding a screen = adding a contract there
 *  plus its client component; no platform change. */
export function createSurfaceTools(params: {
  contracts: Record<string, ComponentContract>;
  catalogId: string;
  stateTree?: StateTree | null;
  sessionKey?: string;
  getSurfaceSnapshot?: (surfaceId: string) => SurfaceSnapshot;
  localization?: FallbackLocalization;
}): ToolModel[] {
  return Object.values(params.contracts).map(
    (contract) =>
      new SurfaceTool({
        contract,
        catalogId: params.catalogId,
        stateTree: params.stateTree,
        sessionKey: params.sessionKey,
        getSurfaceSnapshot: params.getSurfaceSnapshot,
        catalogContracts: params.contracts,
        localization: params.localization,
      }),
  );
}
