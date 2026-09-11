/**
 * Locks the `PropSpec`/`ComponentContract` shape and renders a contract set
 * into a JSON-Schema fragment consumed by the per-component signature
 * surface authoring tools (`Render<Component>`, one per contract).
 */

import type { A2uiComponentNode } from './types.ts';
import { isRecord } from './type-guards.ts';

export type PropType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface PropSpec {
  type: PropType;
  required?: boolean;
  enum?: string[];
  /** Item/field shape. A field map (`Record<string, PropSpec>`) describes
   *  object items/fields; a single `PropSpec` describes scalar or nested
   *  array items (e.g. `rows: string[][]`). Discriminated by the presence of
   *  a string `type` — a field literally named "type" would hold a PropSpec
   *  object, never a string. */
  items?: Record<string, PropSpec> | PropSpec;
  description: string; // consumed verbatim by the generated tool schema
}

export type FallbackMessageValue = string | number | bigint | boolean | null | undefined | Date;

/** Host-owned stable wording for deterministic non-web projections. */
export interface FallbackLocalization {
  format(messageId: string, values?: Record<string, FallbackMessageValue>): string;
}

function isSinglePropSpec(items: Record<string, PropSpec> | PropSpec): items is PropSpec {
  return typeof (items as PropSpec).type === 'string';
}

export interface ComponentContract {
  component: string;
  /** Model-facing one-liner: what this screen is for. Consumed verbatim in
   *  the generated tool description. */
  purpose: string;
  props: Record<string, PropSpec>;
  /** Data-model keys this component WRITES (pointer templates + value types).
   *  Omit when the component writes none. */
  publishes?: Record<string, { valueType: 'string' | 'number' | 'boolean' | 'object' }>;
  /** Actions this component may dispatch (names + context shape). Omit when
   *  the component dispatches none. */
  actions?: Record<string, { context: Record<string, PropSpec> }>;
  /** Deterministic text projection derived from the call's props — this
   *  screen's rendering on every non-web channel. Without one the platform
   *  still derives a generic projection (title + scalar props), so the model
   *  is never asked to write `fallbackMarkdown`; supply this whenever an SMS,
   *  voice or email reader deserves better than that floor. */
  fallbackTemplate?: (
    props: Record<string, unknown>,
    localization?: FallbackLocalization,
  ) => string;
  /** Extra contract-specific validation, run by the surface tool after the
   *  standard prop check. Return human-readable problems (empty = valid). */
  validateProps?: (props: Record<string, unknown>) => string[];
  /** Contract-specific node expansion: when present, the surface tool emits
   *  the returned nodes as the updateComponents payload instead of the
   *  default single root node. Must include a node with id 'root'.
   *  Accepts an optional `pendingChildId` to append one extra dangling id
   *  to the root's children — the progressive-streaming seam
   *  (`composePartial` below) reuses this same function rather than
   *  forking a second compiler. */
  compose?: (
    props: Record<string, unknown>,
    options?: { pendingChildId?: string },
  ) => A2uiComponentNode[];
  /** Progressive composition, called during input streaming with the
   *  best-effort-parsed PARTIAL props (before the call is complete or
   *  validated). Returns the currently-known-complete node set plus the id
   *  of the one node still being written — a completeness test lives
   *  entirely inside this hook; it must never return a half-written
   *  element as a node, only ever as `pendingChildId`. Absent → the surface
   *  tool streams no progressive UI for this contract (explicit opt-in,
   *  not a default — most contracts have no meaningful notion of a
   *  "complete element" mid-stream). */
  composePartial?: (partialProps: Record<string, unknown>) => {
    nodes: A2uiComponentNode[];
  };
  /** Voice-facing facts about this contract. */
  voice?: {
    /** Spoken name for the "awaiting input" state, overriding the
     *  humanized component name (e.g. "sign-up sheet" instead of "form"). */
    pendingLabel?: string;
  };
  /** Composite delegation hook: when present, `resolvePendingAction` calls
   *  this instead of applying the default single-component rule — lets a
   *  container contract (e.g. SectionStack) report which child, if any, is
   *  awaiting input. */
  pendingAction?: (props: Record<string, unknown>) => { component: string; label: string } | null;
}

/** Map one `PropSpec` to a JSON-Schema fragment. Description copied verbatim
 *  (it is the model-facing documentation for the generated tool schema). */
function propSpecToJsonSchema(spec: PropSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: spec.type,
    description: spec.description,
  };
  if (spec.enum) {
    schema['enum'] = spec.enum;
  }
  if (spec.items) {
    if (isSinglePropSpec(spec.items)) {
      // Scalar/nested-array items: the PropSpec IS the item schema.
      schema['items'] = propSpecToJsonSchema(spec.items);
    } else {
      const itemProperties = mapPropSpecs(spec.items);
      if (spec.type === 'array') {
        schema['items'] = { type: 'object', properties: itemProperties };
      } else {
        schema['properties'] = itemProperties;
      }
    }
  }
  return schema;
}

function mapPropSpecs(specs: Record<string, PropSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    properties[name] = propSpecToJsonSchema(spec);
  }
  return properties;
}

function requiredPropNames(specs: Record<string, PropSpec>): string[] {
  return Object.entries(specs)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name);
}

/** Render a contract set into a JSON-Schema fragment: one oneOf branch per
 *  component with its props schema. Descriptions are copied verbatim (they
 *  are the model-facing documentation). MUST NEVER sit at a tool-schema top
 *  level (Bedrock rejects a top-level `oneOf` on `input_schema`) — tool
 *  authors use `contractToFlatToolSchema` instead. */
export function contractsToToolSchema(
  contracts: Record<string, ComponentContract>,
): Record<string, unknown> {
  const oneOf = Object.values(contracts).map((contract) => ({
    type: 'object',
    properties: {
      component: { const: contract.component },
      props: {
        type: 'object',
        properties: mapPropSpecs(contract.props),
        required: requiredPropNames(contract.props),
      },
    },
    required: ['component'],
  }));
  return { oneOf };
}

/** Reserved shared authoring params — a contract prop colliding with one of
 *  these throws when the run's surface tools are built, taking that run's whole
 *  tool set with it (see `contractToFlatToolSchema`). */
export const RESERVED_TOOL_PARAM_NAMES = new Set([
  'surfaceId',
  'dataModel',
  'fallbackMarkdown',
  'chips',
  'nav',
  'voiceSummary',
]);

/** Flat tool schema for ONE contract: contract props at top level (Anthropic
 *  best practice — no unions anywhere) + the shared authoring params.
 *  Throws if a contract prop collides with a reserved param name.
 *
 *  `voiceSummary` is deliberately NOT a param. The fact-driven voice design
 *  (2026-08-10) rejected it as a second model-authored prose copy of the
 *  screen, and the provider-neutral ladder (2026-08-18) owns the speak-while-
 *  working problem without it — the contract-materialized `fallbackMarkdown`
 *  is the one channel-neutral projection voice consumes. The name stays
 *  reserved so an old contract cannot claim it as a prop. */
export function contractToFlatToolSchema(contract: ComponentContract): Record<string, unknown> {
  for (const name of Object.keys(contract.props)) {
    if (RESERVED_TOOL_PARAM_NAMES.has(name)) {
      throw new Error(
        `Contract "${contract.component}" prop "${name}" collides with a reserved tool param`,
      );
    }
  }
  return {
    type: 'object',
    properties: {
      surfaceId: {
        type: 'string',
        description:
          'Stable id for this screen (kebab-case, one per purpose, e.g. "booking-flow"). Re-using an id UPDATES that screen in place.',
      },
      ...mapPropSpecs(contract.props),
      dataModel: {
        type: 'object',
        description:
          "Values to merge into this surface's data model (/surfaces/{surfaceId}) — bindings resolve against it.",
      },
      chips: {
        type: 'array',
        items: { type: 'string' },
        description:
          '2-3 short next-step suggestions shown above the input (ephemeral, SHOULD change every turn).',
      },
    },
    required: ['surfaceId', ...requiredPropNames(contract.props)],
  };
}

/** Prop types `validateComponentProps` runtime-checks (`object` stays loose —
 *  contracts keep object shapes to one level and don't self-describe fields
 *  deeply enough to check them). */
const CHECKED_PROP_TYPES: ReadonlySet<PropType> = new Set(['string', 'number', 'boolean', 'array']);

function matchesRuntimeType(type: PropType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

/** Validate a props object against a contract → human-readable problems
 *  (empty = valid). Checks required presence and primitive/array runtime
 *  type; unknown extra keys are allowed (renderers read only known keys). */
export function validateComponentProps(
  contract: ComponentContract,
  props: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(contract.props)) {
    const value = props[name];
    const isMissing = value === undefined || value === null || value === '';
    if (spec.required && isMissing) {
      problems.push(`Missing required prop "${name}" for ${contract.component}.`);
      continue;
    }
    if (isMissing || !CHECKED_PROP_TYPES.has(spec.type)) {
      continue;
    }
    if (!matchesRuntimeType(spec.type, value)) {
      problems.push(`Prop "${name}" of ${contract.component} must be a ${spec.type}.`);
    }
  }
  return problems;
}

/** Every key `ComponentContract` declares. Exhaustive by construction: adding a
 *  field to the interface without adding it here fails to compile. */
const CONTRACT_KEYS_MAP: Record<keyof ComponentContract, true> = {
  component: true,
  purpose: true,
  props: true,
  publishes: true,
  actions: true,
  fallbackTemplate: true,
  validateProps: true,
  compose: true,
  composePartial: true,
  voice: true,
  pendingAction: true,
};

const CONTRACT_KEYS: ReadonlySet<string> = new Set(Object.keys(CONTRACT_KEYS_MAP));
const PROP_TYPES: ReadonlySet<string> = new Set<PropType>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
]);
const REQUIRED_CONTRACT_FIELDS = ['component', 'purpose', 'props'] as const;
const MAX_SPEC_DEPTH = 6;

export interface ContractProblem {
  /** Authoring component name, or `<unnamed>` when the contract omits it. */
  contract: string;
  /** Dotted path to the offending node, e.g. `props.rows.items`. */
  path: string;
  message: string;
  /** `error` = the agent misbehaves or the run dies. `warning` = the contract is
   *  untidy and the schema is poorer, but behaviour is unchanged. */
  severity: 'error' | 'warning';
}

type AddProblem = (path: string, message: string, severity?: ContractProblem['severity']) => void;

/**
 * Structural check of an authored contract. TypeScript rejects most of this at
 * authoring time, but the agent bundle is built with types stripped, so a broken
 * contract ships and degrades the generated tool schema in silence.
 */
export function validateContractShape(contract: unknown): ContractProblem[] {
  const problems: ContractProblem[] = [];
  if (!isRecord(contract)) {
    return [{ contract: '<unnamed>', path: '', message: 'not an object', severity: 'error' }];
  }

  const component = contract['component'];
  const name = typeof component === 'string' && component ? component : '<unnamed>';
  const add: AddProblem = (path, message, severity = 'warning') => {
    problems.push({ contract: name, path, message, severity });
  };

  for (const key of Object.keys(contract)) {
    if (!CONTRACT_KEYS.has(key)) {
      add(key, `unknown field "${key}" — not part of ComponentContract`);
    }
  }
  for (const field of REQUIRED_CONTRACT_FIELDS) {
    const value = contract[field];
    if (value === undefined || value === null || value === '') {
      add(field, `missing "${field}" — building this contract's tool will throw`, 'error');
    }
  }

  const props = contract['props'];
  if (props !== undefined && props !== null && !isRecord(props)) {
    add('props', 'props must be a map of PropSpecs keyed by prop name', 'error');
  }
  for (const name of isRecord(props) ? Object.keys(props) : []) {
    if (RESERVED_TOOL_PARAM_NAMES.has(name)) {
      add(
        `props.${name}`,
        `"${name}" is a reserved authoring param — building this contract's tool will throw`,
        'error',
      );
    }
  }
  collectPropProblems(props, 'props', add);

  const publishes = contract['publishes'];
  if (publishes !== undefined && !isRecord(publishes)) {
    add('publishes', 'publishes must be a map of { valueType } keyed by data path', 'error');
  }
  if (isRecord(publishes)) {
    for (const [path, declaration] of Object.entries(publishes)) {
      if (!isRecord(declaration)) {
        add(`publishes.${path}`, 'expected { valueType }', 'error');
        continue;
      }
      const valueType = declaration['valueType'];
      if (!['string', 'number', 'boolean', 'object'].includes(String(valueType))) {
        add(`publishes.${path}.valueType`, 'expected string, number, boolean, or object', 'error');
      }
    }
  }

  const actions = contract['actions'];
  if (actions !== undefined && !isRecord(actions)) {
    add('actions', 'actions must be a map of { context } keyed by action name', 'error');
  }
  if (isRecord(actions)) {
    for (const [action, declaration] of Object.entries(actions)) {
      if (!isRecord(declaration)) {
        add(`actions.${action}`, 'expected { context: { … } }', 'error');
        continue;
      }
      collectPropProblems(declaration['context'], `actions.${action}.context`, add);
    }
  }

  return problems;
}

function collectPropProblems(specs: unknown, basePath: string, add: AddProblem, depth = 0): void {
  if (!isRecord(specs)) {
    return;
  }
  for (const [name, spec] of Object.entries(specs)) {
    collectSpecProblems(spec, `${basePath}.${name}`, add, depth);
  }
}

function collectSpecProblems(spec: unknown, path: string, add: AddProblem, depth: number): void {
  // Also the cycle guard: a self-referencing spec recurses forever here and in
  // the schema generator, which has no such guard.
  if (depth > MAX_SPEC_DEPTH) {
    add(path, `nested deeper than ${MAX_SPEC_DEPTH} levels — keep prop shapes shallow`, 'error');
    return;
  }
  if (!isRecord(spec)) {
    add(path, 'expected a PropSpec object', 'error');
    return;
  }
  // Dominant defect: everything else on this node is noise until it is restructured.
  if ('properties' in spec) {
    add(
      path,
      'carries a JSON-Schema "properties" key, which the schema generator ignores — describe fields through `items` as a field map: { field: { type, description } }',
      'error',
    );
    return;
  }

  const type = spec['type'];
  if (typeof type !== 'string' || !PROP_TYPES.has(type)) {
    add(
      path,
      `type ${JSON.stringify(type)} is not a PropSpec type (string | number | boolean | object | array)`,
      'error',
    );
  }
  if (typeof spec['description'] !== 'string' || spec['description'].trim() === '') {
    add(
      path,
      'no description — the generated tool schema hands the model an undocumented parameter',
    );
  }

  const items = spec['items'];
  if (items === undefined) {
    if (type === 'array') {
      add(
        path,
        'array without items — providers reject the schema and the model gets no element shape',
        'error',
      );
    }
    return;
  }
  if (!isRecord(items)) {
    add(`${path}.items`, 'expected a PropSpec or a field map of PropSpecs', 'error');
    return;
  }
  if (typeof items['type'] === 'string') {
    if (!('properties' in items) && items['type'] === 'object' && items['items'] === undefined) {
      add(
        `${path}.items`,
        'object items with no field map — the element schema documents nothing; list the fields: items: { field: { type, description } }',
        'error',
      );
      return;
    }
    collectSpecProblems(items, `${path}.items`, add, depth + 1);
    return;
  }
  collectPropProblems(items, `${path}.items`, add, depth + 1);
}

/** `ContactForm` → `contact form`. Fallback spoken name when a contract has
 *  no `voice.pendingLabel`. */
export function humanizeComponentName(component: string): string {
  return component.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** What, if anything, this rendered contract is waiting on the visitor for —
 *  the fact voice announces as "awaiting input on {label}". A composite
 *  contract (`pendingAction`) delegates to whichever child is actionable; a
 *  leaf contract is actionable whenever it declares any `actions`. */
export function resolvePendingAction(
  contract: ComponentContract,
  props: Record<string, unknown>,
): { component: string; label: string } | null {
  if (contract.pendingAction) {
    return contract.pendingAction(props);
  }
  if (Object.keys(contract.actions ?? {}).length === 0) {
    return null;
  }
  return {
    component: contract.component,
    label: contract.voice?.pendingLabel ?? humanizeComponentName(contract.component),
  };
}
