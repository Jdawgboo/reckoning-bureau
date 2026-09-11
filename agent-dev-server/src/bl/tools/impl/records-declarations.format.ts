/**
 * Renders the agent's declared collections into the `manageRecords` tool
 * description, so required fields, enum values, and the ops each collection
 * allows are in context BEFORE the first write instead of being learned from a
 * rejection.
 *
 * Two constraints shape the output. It must be byte-stable for unchanged
 * declarations — a tool description that differs between turns invalidates the
 * whole cached prompt prefix. And it must describe only what
 * `validateAgainstSchema` actually enforces (root `properties`/`required`, and
 * per-property `type`, `enum`, `format: 'date-time'`): promising validation the
 * platform does not perform is worse than saying less.
 */

import type { CollectionDeclaration } from '../../../../vendor/agent-library/records/types.ts';
import { compareValues } from '../../../../vendor/agent-library/records/record-envelope.ts';
import { isRecord } from '../../../util/type-guards.ts';

/**
 * Kept tight on purpose: subagents inherit the records tool, so this block is
 * paid once per registry, not once per agent.
 */
export const MAX_DECLARATIONS_BLOCK_CHARS = 4_000;

const MAX_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_FIELD_NAME_CHARS = 60;
const MAX_ENUM_VALUE_CHARS = 40;
const MAX_ENUM_VALUES = 20;
const MAX_SECTION_CHARS = 1_200;

const HEADING = '## Your collections';
const PREAMBLE = 'The platform enforces these rules server-side; a call outside them is rejected.';
const SEPARATOR = '\n\n';

/**
 * EVERY builder-authored string reaching this block goes through here —
 * collection name, title, description, property names, enum values. The block is
 * line-oriented, so a newline or a leading `#` would let a declaration forge a
 * second collection entry claiming wider permissions. The gate would still
 * refuse the call, but the agent would have promised it to a visitor first.
 *
 * Builder-authored is not trusted: a builder agent reads scraped pages and MCP
 * output, so declaration text can carry someone else's instructions.
 */
function sanitizeText(value: string, maxChars: number): string {
  const collapsed = value
    // `\s` misses C0/C1 controls, zero-width joiners and bidi overrides. None of
    // them can forge a line, but they do sit in the model's context every turn.
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .replace(/^[#>\-*|\s]+/, '')
    .trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

function formatScope(declaration: CollectionDeclaration): string {
  return declaration.scope === 'session'
    ? 'rows created in the current visitor session only'
    : 'all rows';
}

function formatPropertyType(propertySchema: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (typeof propertySchema['type'] === 'string') {
    parts.push(propertySchema['type']);
  }
  if (propertySchema['format'] === 'date-time') {
    parts.push('ISO date-time');
  }
  return parts;
}

function formatAllowedValues(allowed: unknown[]): string {
  const shown = allowed
    .slice(0, MAX_ENUM_VALUES)
    .map((value) => sanitizeText(String(value), MAX_ENUM_VALUE_CHARS));
  const suffix = allowed.length > MAX_ENUM_VALUES ? `, … (${allowed.length} in total)` : '';
  return `${shown.join(', ')}${suffix}`;
}

function formatProperty(
  rawField: string,
  propertySchema: unknown,
  required: ReadonlySet<string>,
): string {
  const field = sanitizeText(rawField, MAX_FIELD_NAME_CHARS);
  if (!isRecord(propertySchema)) {
    return `- ${field}${required.has(rawField) ? ' (required)' : ''}`;
  }
  const facets = formatPropertyType(propertySchema);
  if (required.has(rawField)) {
    facets.push('required');
  }
  const head = facets.length > 0 ? `- ${field} (${facets.join(', ')})` : `- ${field}`;
  const allowed = propertySchema['enum'];
  if (Array.isArray(allowed) && allowed.length > 0) {
    return `${head} — one of: ${formatAllowedValues(allowed)}`;
  }
  return head;
}

function formatFields(declaration: CollectionDeclaration): string[] {
  const schema = declaration.schema;
  if (!isRecord(schema) || !isRecord(schema['properties'])) {
    return ['Fields: not declared — any fields are accepted.'];
  }
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((field): field is string => typeof field === 'string')
      : [],
  );
  const properties = Object.entries(schema['properties']);
  if (properties.length === 0) {
    return ['Fields: not declared — any fields are accepted.'];
  }
  return [
    'Fields:',
    ...properties.map(([field, propertySchema]) => formatProperty(field, propertySchema, required)),
  ];
}

function formatHeader(name: string, declaration: CollectionDeclaration): string {
  const title = declaration.title ? sanitizeText(declaration.title, MAX_TITLE_CHARS) : '';
  return title.length > 0 ? `### ${name} — ${title}` : `### ${name}`;
}

function formatDeclaration(declaration: CollectionDeclaration): string {
  const name = sanitizeText(declaration.name, MAX_FIELD_NAME_CHARS);
  const lines = [formatHeader(name, declaration)];
  if (declaration.description) {
    // Labelled rather than bare: a description on a line of its own could open
    // with "You may:" or "###" and read as structure.
    lines.push(`Purpose: ${sanitizeText(declaration.description, MAX_DESCRIPTION_CHARS)}`);
  }
  lines.push(`You may: ${declaration.ops.join(', ')} — ${formatScope(declaration)}.`);
  lines.push(...formatFields(declaration));
  const section = lines.join('\n');
  if (section.length <= MAX_SECTION_CHARS) {
    return section;
  }
  return `${section.slice(0, MAX_SECTION_CHARS)}\n(field list truncated — read a record back with \`get\` if unsure.)`;
}

/** One line per collection that did not fit, so nothing disappears silently. */
function formatSummaryLine(declaration: CollectionDeclaration): string {
  const name = sanitizeText(declaration.name, MAX_FIELD_NAME_CHARS);
  return `- ${name}: ${declaration.ops.join(', ')} — ${formatScope(declaration)}.`;
}

function assemble(detailed: CollectionDeclaration[], omitted: CollectionDeclaration[]): string {
  const sections = detailed.map(formatDeclaration);
  if (omitted.length > 0) {
    sections.push(
      [
        `Field lists omitted for ${omitted.length} more collection(s) — the platform still`,
        'enforces their schemas, so read one back with `get` before writing if unsure:',
        ...omitted.map(formatSummaryLine),
      ].join('\n'),
    );
  }
  return [HEADING, '', PREAMBLE, '', sections.join(SEPARATOR)].join('\n');
}

/** Last resort: as many names as the cap holds, and a count of the rest. */
function assembleCounted(sorted: CollectionDeclaration[]): string {
  for (let shown = sorted.length; shown > 0; shown--) {
    const lines = sorted.slice(0, shown).map(formatSummaryLine);
    if (shown < sorted.length) {
      lines.push(`- … and ${sorted.length - shown} more collection(s).`);
    }
    const block = [HEADING, '', PREAMBLE, '', ...lines].join('\n');
    if (block.length <= MAX_DECLARATIONS_BLOCK_CHARS) {
      return block;
    }
  }
  return [HEADING, '', PREAMBLE, '', `${sorted.length} collections declared.`].join('\n');
}

/**
 * The block appended to the records tool description, or `''` when the agent
 * has no declared collections. Never exceeds
 * {@link MAX_DECLARATIONS_BLOCK_CHARS}: field lists degrade to one-line
 * summaries first, and only then do names give way to a count — nothing is
 * dropped without being counted.
 */
export function formatCollectionDeclarations(declarations: CollectionDeclaration[]): string {
  if (declarations.length === 0) {
    return '';
  }
  const sorted = [...declarations].sort((a, b) => compareValues(a.name, b.name));

  for (let detailedCount = sorted.length; detailedCount > 0; detailedCount--) {
    const block = assemble(sorted.slice(0, detailedCount), sorted.slice(detailedCount));
    if (block.length <= MAX_DECLARATIONS_BLOCK_CHARS) {
      return block;
    }
  }
  return assembleCounted(sorted);
}
