/**
 * Pure helpers for the generic surface tools. Contract-agnostic: every function takes
 * the contract (and catalog id) as parameters — contract instances live in
 * `src/surfaces/index.ts`, never here. Kept standalone (no barrel imports) so the
 * logic is unit-testable without the ToolModel graph.
 */
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';
import {
  validateComponentProps,
  type ComponentContract,
  type FallbackLocalization,
} from '../../../../vendor/agentplace-a2ui/contract-schema.ts';
import { isRecord, isStringArray } from '../../../util/type-guards.ts';
import { setAtPointer } from '../../../../vendor/agentplace-a2ui/data-model.ts';

export interface RenderSurfaceInput {
  surfaceId: string;
  contract: ComponentContract;
  catalogId: string;
  props: Record<string, unknown>;
  /**
   * Sections already on the visitor's screen that are worth preserving —
   * **already filtered by the caller**, which is the layer that knows the
   * catalog (see `contractHoldsVisitorState`). Any the new composition omits
   * are appended, so answering a question does not destroy the form the
   * question was about. Supplied only when a live screen exists and the client
   * is in site mode; `null` everywhere else.
   *
   * This function deliberately does not decide what "worth preserving" means —
   * that is a contract-semantics question and belongs where contracts are
   * resolvable.
   *
   * Applies to composable (section-stack) renders. A single-component render
   * reusing a `surfaceId` is an explicit "this screen is now just this".
   */
  carryForward?: ReadonlyArray<unknown> | null;
  localization?: FallbackLocalization;
}

export interface SurfaceEvent {
  name: string;
  value: unknown;
}

export type BuildSurfaceEventsResult =
  | { ok: true; events: SurfaceEvent[]; fallbackMarkdown: string }
  | { ok: false; error: string };

/** Validate + build the two AG-UI CUSTOM events for one static-generative
 *  surface. Default: a single custom-component root the agent picks and
 *  fills; a contract's `compose` hook may expand the call into a multi-node
 *  tree instead (e.g. SectionStack → Column + section children). */
export function buildSurfaceEvents(input: RenderSurfaceInput): BuildSurfaceEventsResult {
  const problems = [
    ...validateComponentProps(input.contract, input.props),
    ...(input.contract.validateProps ? input.contract.validateProps(input.props) : []),
  ];
  if (problems.length > 0) {
    return { ok: false, error: `Cannot render ${input.contract.component}: ${problems.join(' ')}` };
  }

  const carried = sectionsToCarryForward(input);
  const props = carried.length > 0 ? withCarriedSections(input.props, carried) : input.props;

  const fallbackMarkdown =
    input.contract.fallbackTemplate?.(props, input.localization) ||
    deriveFallbackMarkdown(input.contract.component, props);

  const components = input.contract.compose
    ? input.contract.compose(props)
    : [{ ...props, id: 'root', component: input.contract.component }];

  const events: SurfaceEvent[] = [
    {
      name: A2UI_EVENT_NAMES.createSurface,
      value: {
        surfaceId: input.surfaceId,
        catalogId: input.catalogId,
        fallbackMarkdown,
      },
    },
    {
      name: A2UI_EVENT_NAMES.updateComponents,
      value: {
        surfaceId: input.surfaceId,
        components,
      },
    },
  ];
  return { ok: true, events, fallbackMarkdown };
}

/**
 * Merge a tool call's `dataModel` into the session uiState document.
 * Pointer-form keys (leading `/`, e.g. `/chips`, `/nav`) are root-level uiState
 * writes — the stage shell reads chips and nav from the document root. Bare keys
 * seed the surface's own node under `/surfaces/{surfaceId}`, which is the scope
 * bindings resolve against and the same node the visitor's own typing writes to.
 */
export function mergeSeedIntoUiState(
  current: unknown,
  surfaceId: string,
  dataModel: Record<string, unknown>,
): Record<string, unknown> {
  const surfaceSeed: Record<string, unknown> = {};
  let doc: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(dataModel)) {
    if (key.startsWith('/')) {
      const next = setAtPointer(doc, key, value);
      doc = isRecord(next) ? next : doc;
    } else {
      surfaceSeed[key] = value;
    }
  }
  const surfaces = isRecord(doc.surfaces) ? doc.surfaces : {};
  return { ...doc, surfaces: { ...surfaces, [surfaceId]: surfaceSeed } };
}

export interface SplitToolInputResult {
  surfaceId: string;
  /** Every contract prop present in the flat tool input. */
  props: Record<string, unknown>;
  /** Seeds `/surfaces/{surfaceId}` in the session's uiState data model. */
  dataModel: Record<string, unknown> | undefined;
  /** Root-level stage state from the explicit params (validated). */
  chips: string[] | undefined;
  /** Model-authored spoken-register answer, present only when voice is active. */
}

const STRAY_SURROGATE_PAIR = /(?<!\\)\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/gi;
const STRAY_UNICODE_ESCAPE = /(?<!\\)\\u([0-9a-f]{4})/gi;

/**
 * Decode `\uXXXX` escape sequences that survived JSON parsing as literal text.
 *
 * Models occasionally over-escape non-ASCII characters when authoring tool-call
 * JSON — the argument source carries `\\u00a3` where `£` was meant, so the
 * parsed string holds the six characters `\u00a3` instead of `£`. Surface
 * strings are visitor-facing prose, so the stray sequence would reach the
 * screen, the markdown fallback, and the spoken summary verbatim.
 *
 * Conservative by construction: surrogate pairs decode together, a lone
 * surrogate or invalid hex stays as written, and a sequence preceded by a
 * backslash stays as written (the author escaped it deliberately). Prose that
 * intends to DISPLAY an escape sequence is mis-decoded — accepted, because
 * surfaces are prose-register and that intent is far rarer than the defect.
 */
function decodeStrayUnicodeEscapes(text: string): string {
  if (!text.includes('\\u')) {
    return text;
  }
  const paired = text.replace(STRAY_SURROGATE_PAIR, (_match, high: string, low: string) =>
    String.fromCharCode(Number.parseInt(high, 16), Number.parseInt(low, 16)),
  );
  return paired.replace(STRAY_UNICODE_ESCAPE, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdfff) {
      return match;
    }
    return String.fromCharCode(code);
  });
}

function decodeStrayUnicodeEscapesDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return decodeStrayUnicodeEscapes(value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeStrayUnicodeEscapesDeep);
  }
  if (isRecord(value)) {
    return decodeRecordStrings(value);
  }
  return value;
}

/** Apply {@link decodeStrayUnicodeEscapes} to every string in a record tree.
 *  Used for the final tool input and for streamed partial input alike, so a
 *  screen never shows a stray escape even transiently. */
export function decodeRecordStrings(value: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    decoded[key] = decodeStrayUnicodeEscapesDeep(entry);
  }
  return decoded;
}

/** Divide a flat per-component tool input into the shared authoring params
 *  plus the contract's own props (every contract prop key present on the
 *  input, regardless of the reserved shared param names). Display-bound
 *  strings are normalized via {@link decodeStrayUnicodeEscapes}; `surfaceId`
 *  is identity, never rewritten. */
export function splitToolInput(
  contract: ComponentContract,
  input: Record<string, unknown>,
): SplitToolInputResult {
  const props: Record<string, unknown> = {};
  for (const name of Object.keys(contract.props)) {
    if (name in input) {
      props[name] = decodeStrayUnicodeEscapesDeep(input[name]);
    }
  }
  const surfaceId = typeof input['surfaceId'] === 'string' ? input['surfaceId'] : '';
  const dataModel = isRecord(input['dataModel'])
    ? decodeRecordStrings(input['dataModel'])
    : undefined;
  const chips = isStringArray(input['chips'])
    ? input['chips'].map(decodeStrayUnicodeEscapes)
    : undefined;
  return { surfaceId, props, dataModel, chips };
}

/**
 * Last-resort text projection for a contract with no `fallbackTemplate`.
 *
 * The projection is authored on the contract, never asked of the model: a
 * per-render `fallbackMarkdown` param made it write a second prose copy of the
 * screen it had just composed, before the tool call could complete, and so
 * directly on the path to first audio.
 *
 * Deliberately plain: scalars listed, arrays counted, nothing invented. A
 * contract that cares how it reads on SMS or voice supplies a `fallbackTemplate`
 * — this is the floor that keeps a missing one from being silence.
 */
function deriveFallbackMarkdown(component: string, props: Record<string, unknown>): string {
  const title = typeof props['title'] === 'string' ? props['title'] : component;
  const lines = [`# ${title}`];
  for (const [key, value] of Object.entries(props)) {
    if (key === 'title' || value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`- ${key}: ${value.length} item${value.length === 1 ? '' : 's'}`);
    } else if (typeof value !== 'object') {
      lines.push(`- ${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

function sectionsToCarryForward(input: RenderSurfaceInput): unknown[] {
  const candidates = input.carryForward;
  if (!candidates || candidates.length === 0) {
    return [];
  }
  const incoming = readSectionComponents(input.props);
  return candidates.filter((section) => {
    if (!isRecord(section)) {
      return false;
    }
    const component = section['component'];
    return typeof component === 'string' && !incoming.has(component);
  });
}

function readSectionComponents(props: Record<string, unknown>): Set<string> {
  const sections = props['sections'];
  if (!Array.isArray(sections)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const section of sections) {
    if (isRecord(section) && typeof section['component'] === 'string') {
      names.add(section['component']);
    }
  }
  return names;
}

function withCarriedSections(
  props: Record<string, unknown>,
  carried: readonly unknown[],
): Record<string, unknown> {
  const sections = Array.isArray(props['sections']) ? props['sections'] : [];
  return { ...props, sections: [...sections, ...carried] };
}
