/**
 * Resolves "press the control called X" into the payload the browser component would send.
 *
 * Pure and standalone for the same reason `voice-screen.ts` is. A builtin's controls come
 * from `PRESS_TARGETS`; anything else is addressable only by the action names its contract
 * declares, since captions and typed values live in the browser.
 */

import { resolvePointer } from '../../vendor/agentplace-a2ui/data-model.ts';
import { evaluateChecks } from '../../vendor/agentplace-a2ui/functions.ts';
import { isSensitiveFieldKind } from '../../vendor/agentplace-a2ui/field-sensitivity.ts';
import { collectCheckedNodes, resolveActionContext } from '../../vendor/agentplace-a2ui/actions.ts';
import { resolveSurface, type ResolvedNode } from '../../vendor/agentplace-a2ui/walker.ts';
import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import type { ComponentContract, PropSpec } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord } from '../util/type-guards.ts';
import { PRESS_TARGETS } from './press-targets.ts';

export type SurfaceContractCatalog = Record<string, ComponentContract>;

export interface ResolvedClick {
  outcome: 'resolved';
  surfaceId: string;
  /** null when pressing this control sends a plain visitor message, as a TextBlock button does. */
  action: string | null;
  context: Record<string, unknown>;
  /** The visitor-facing message text, matching what the component sends. */
  message: string;
  skippedSensitiveChecks: string[];
}

export type ClickFailure =
  | { outcome: 'no_surface' }
  | { outcome: 'not_found'; available: string[] }
  | { outcome: 'ambiguous'; matches: string[] }
  | { outcome: 'unavailable'; caption: string; reason: string }
  | { outcome: 'context_required'; action: string; missing: string[] }
  | { outcome: 'checks_failed'; messages: string[]; skippedSensitiveChecks: string[] };

/** Discriminated on a single string because this package builds with
 *  `strictNullChecks: false`, where a boolean discriminant does not narrow. */
export type ClickResolution = ResolvedClick | ClickFailure;

interface Candidate {
  caption: string;
  action: string | null;
  message: string;
  /** Resolved context, or null when it must be assembled from the declaration. */
  context: Record<string, unknown> | null;
  declaredContext?: Record<string, PropSpec>;
  unavailable?: string;
}

export function resolveClick({
  surfaceId,
  surface,
  uiState,
  requested,
  catalog,
  suppliedContext,
}: {
  surfaceId: string | null;
  surface: ReducedSurface | undefined;
  uiState: Record<string, unknown> | null;
  requested: string;
  catalog: SurfaceContractCatalog;
  suppliedContext?: Record<string, unknown>;
}): ClickResolution {
  if (!surfaceId || !surface) {
    return { outcome: 'no_surface' };
  }

  const dataModel = surfaceDataModel(uiState, surfaceId);
  const tree = resolveSurface(surface, dataModel);
  if (!tree) {
    return { outcome: 'no_surface' };
  }

  const candidates: Candidate[] = [];
  collectCandidates(tree, catalog, candidates);

  const matched = matchCandidates(candidates, requested);
  if (matched.length === 0) {
    return { outcome: 'not_found', available: candidates.map((candidate) => candidate.caption) };
  }
  if (matched.length > 1) {
    return { outcome: 'ambiguous', matches: matched.map((candidate) => candidate.caption) };
  }

  const target = matched[0];
  if (target.unavailable) {
    return { outcome: 'unavailable', caption: target.caption, reason: target.unavailable };
  }

  const context = assembleContext(target, suppliedContext, dataModel);
  if (Array.isArray(context)) {
    return {
      outcome: 'context_required',
      action: target.action ?? target.caption,
      missing: context,
    };
  }

  const sensitiveFieldIds = new Set<string>();
  collectSensitiveFieldIds(tree, sensitiveFieldIds);

  const { messages, skippedSensitiveChecks } = evaluateGatingChecks(
    tree,
    dataModel,
    sensitiveFieldIds,
  );
  if (messages.length > 0) {
    return { outcome: 'checks_failed', messages, skippedSensitiveChecks };
  }

  return {
    outcome: 'resolved',
    surfaceId,
    action: target.action,
    context,
    message: target.message,
    skippedSensitiveChecks,
  };
}

/** The scope the browser resolves pointers against. */
function surfaceDataModel(uiState: Record<string, unknown> | null, surfaceId: string): unknown {
  const surfaces = uiState?.surfaces;
  if (!isRecord(surfaces)) {
    return {};
  }
  const scoped = surfaces[surfaceId];
  return isRecord(scoped) ? scoped : {};
}

function collectCandidates(
  node: ResolvedNode,
  catalog: SurfaceContractCatalog,
  out: Candidate[],
): void {
  const contract = catalog[node.component];
  if (contract) {
    out.push(...candidatesOf(contract, node.component, node.props));
  }
  for (const child of node.children) {
    collectCandidates(child, catalog, out);
  }
}

function candidatesOf(
  contract: ComponentContract,
  component: string,
  props: Record<string, unknown>,
): Candidate[] {
  const actions = contract.actions ?? {};
  const projected = PRESS_TARGETS[component]?.(props);
  // An agent may author a component under a builtin's name, in which case the projection
  // describes a screen that is not on offer. Its own declaration is the authority.
  if (projected && projected.every((t) => t.action === null || t.action in actions)) {
    return projected.map((target) => ({
      caption: target.caption,
      action: target.action,
      message: target.message ?? target.action ?? target.caption,
      context: target.context ?? {},
      ...(target.unavailable ? { unavailable: target.unavailable } : {}),
    }));
  }
  return Object.entries(actions).map(([action, declaration]) => ({
    caption: humanize(action),
    action,
    message: action,
    context: null,
    declaredContext: declaration.context,
  }));
}

/** `confirmBooking` reads as "confirm booking" — the caption such an action usually carries. */
function humanize(action: string): string {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/** First tier with a hit wins. Several hits in one tier is ambiguity: refusing beats
 *  pressing the wrong control. */
function matchCandidates(candidates: Candidate[], requested: string): Candidate[] {
  const needle = requested.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const tiers: Candidate[][] = [
    candidates.filter((candidate) => candidate.caption.trim().toLowerCase() === needle),
    candidates.filter((candidate) => candidate.action?.toLowerCase() === needle),
    candidates.filter(
      (candidate) => candidate.action !== null && humanize(candidate.action) === needle,
    ),
    candidates.filter((candidate) => candidate.caption.toLowerCase().includes(needle)),
  ];

  return tiers.find((tier) => tier.length > 0) ?? [];
}

/** A projected target carries its own context; a declaration-only one takes it from the
 *  caller or from state, and returns the required keys it still cannot fill. */
function assembleContext(
  target: Candidate,
  suppliedContext: Record<string, unknown> | undefined,
  dataModel: unknown,
): Record<string, unknown> | string[] {
  if (target.context !== null) {
    return resolveActionContext(target.context, (pointer) => resolvePointer(dataModel, pointer));
  }

  const declared = target.declaredContext ?? {};
  const context: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [key, spec] of Object.entries(declared)) {
    const supplied = suppliedContext?.[key];
    if (supplied !== undefined) {
      context[key] = supplied;
      continue;
    }
    const published = resolvePointer(dataModel, `/${key}`);
    if (published !== undefined) {
      context[key] = published;
      continue;
    }
    if (spec.required) {
      missing.push(key);
    }
  }
  return missing.length > 0 ? missing : context;
}

function collectSensitiveFieldIds(node: ResolvedNode, out: Set<string>): void {
  const fields = node.props.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (isRecord(field) && typeof field.id === 'string' && isSensitiveFieldKind(field.kind)) {
        out.add(field.id);
      }
    }
  }
  for (const child of node.children) {
    collectSensitiveFieldIds(child, out);
  }
}

/** Every check the browser would run, minus those reading a field kind withheld from state
 *  sync: absent here by design, so checking them would fail a form a visitor could submit. */
function evaluateGatingChecks(
  tree: ResolvedNode,
  dataModel: unknown,
  sensitiveFieldIds: Set<string>,
): { messages: string[]; skippedSensitiveChecks: string[] } {
  const checkedNodes: ResolvedNode[] = [];
  collectCheckedNodes(tree, checkedNodes);

  const messages: string[] = [];
  const skipped = new Set<string>();
  for (const node of checkedNodes) {
    const checks = Array.isArray(node.props.checks)
      ? node.props.checks.filter((check) => {
          const fieldId = sensitiveFieldOfCheck(check, sensitiveFieldIds);
          if (fieldId === null) {
            return true;
          }
          skipped.add(fieldId);
          return false;
        })
      : node.props.checks;
    const result = evaluateChecks(checks, dataModel);
    if (!result.ok) {
      messages.push(...result.messages);
    }
  }
  return { messages, skippedSensitiveChecks: [...skipped] };
}

function sensitiveFieldOfCheck(check: unknown, sensitiveFieldIds: Set<string>): string | null {
  if (!isRecord(check) || !isRecord(check.args)) {
    return null;
  }
  const value = check.args.value;
  if (!isRecord(value) || typeof value.path !== 'string') {
    return null;
  }
  const fieldId = value.path.split('/').pop();
  return fieldId !== undefined && sensitiveFieldIds.has(fieldId) ? fieldId : null;
}
