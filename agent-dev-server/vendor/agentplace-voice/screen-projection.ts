/**
 * A bounded, spoken-register description of what is on the visitor's screen.
 *
 * Replaces a one-sentence summary. With a sentence, voice can say "there is a
 * booking form on screen"; it cannot say "the second option", "the date is
 * still blank", or "want me to put your name in?" — deixis, which is most of
 * what makes talking about a shared thing with someone feel human.
 *
 * **Why this is allowed to exist.** The common-ground invariant lets voice hold
 * what the visitor has already seen or heard. The screen is definitionally
 * common ground, so its structure leaks nothing they are not already looking
 * at. It does NOT widen what voice knows about the business — prices,
 * availability and records still reach it only through delivered answers.
 *
 * **Why it must be bounded.** Per-response `instructions` are re-sent and
 * re-billed on EVERY utterance. A thirty-row table cannot go in. Truncation
 * order is therefore fixed: **drop content before structure** — knowing a table
 * has thirty rows is worth more to a speaker than knowing what row seven says.
 */

import { isRecord } from './util/type-guards.ts';

/** Field-ish props a component may expose. Structural only — no contract import,
 *  keeping this library role-agnostic. */
interface ProjectedField {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  options?: unknown;
}

export interface ScreenProjectionInput {
  /** Sections composed on the surface, in screen order. */
  sections: ReadonlyArray<{ component: string; props: Record<string, unknown> }>;
  /** Current data-model values, keyed by field id. */
  values: Record<string, unknown>;
  /** Contract-derived projection of the visible content, never model-authored at voice time. */
  fallbackText?: string;
  /** Values that must never be spoken or held (payment, credentials). */
  isSensitive: (fieldId: string) => boolean;
  /** Character budget for the whole block. */
  maxChars: number;
}

const EMPTY_SCREEN = 'nothing is on the visitor’s screen yet';
const MAX_OPTIONS_SPOKEN = 6;

export function projectScreen(input: ScreenProjectionInput): string {
  if (input.sections.length === 0) {
    return EMPTY_SCREEN;
  }
  const detailed = input.sections.map((section) => describeSection(section, input)).join('; ');
  const visibleContent = input.fallbackText?.trim() ?? '';
  const complete = visibleContent ? `shown content: ${visibleContent}; ${detailed}` : detailed;
  if (complete.length <= input.maxChars) {
    return complete;
  }
  const summarised = input.sections.map((section) => summariseSection(section)).join('; ');
  if (!visibleContent) {
    return summarised.length <= input.maxChars ? summarised : summarised.slice(0, input.maxChars);
  }
  const suffix = `; ${summarised}`;
  const marker = '… (truncated)';
  const available = Math.max(
    0,
    input.maxChars - 'shown content: '.length - suffix.length - marker.length,
  );
  if (available === 0) {
    return summarised.slice(0, input.maxChars);
  }
  return `shown content: ${visibleContent.slice(0, available)}${marker}${suffix}`.slice(
    0,
    input.maxChars,
  );
}

function describeSection(
  section: { component: string; props: Record<string, unknown> },
  input: ScreenProjectionInput,
): string {
  const fields = readFields(section.props);
  if (fields.length === 0) {
    return summariseSection(section);
  }
  const parts = fields.map((field) => describeField(field, input));
  return `${section.component} — ${parts.join(', ')}`;
}

/** A sensitive field is NAMED but never valued: voice can refer to it without
 *  being able to read it aloud, since it speaks straight to the wire. */
function describeField(field: ProjectedField, input: ScreenProjectionInput): string {
  const id = typeof field.id === 'string' ? field.id : '';
  const label = typeof field.label === 'string' && field.label ? field.label : id;
  const options = readOptions(field.options);
  if (options.length > 0) {
    const shown = options.slice(0, MAX_OPTIONS_SPOKEN).join(', ');
    const rest =
      options.length > MAX_OPTIONS_SPOKEN ? `, +${options.length - MAX_OPTIONS_SPOKEN}` : '';
    return `${label} (options: ${shown}${rest})`;
  }
  if (id && input.isSensitive(id)) {
    return `${label}: (hidden)`;
  }
  const value = id ? input.values[id] : undefined;
  return `${label}: ${formatValue(value)}`;
}

/** Structure only — component, plus a count of whatever bulk content it holds.
 *  What a section is beats what it contains when the budget runs out. */
function summariseSection(section: { component: string; props: Record<string, unknown> }): string {
  const counts: string[] = [];
  for (const [key, value] of Object.entries(section.props)) {
    if (Array.isArray(value) && value.length > 0) {
      counts.push(`${value.length} ${key}`);
    }
  }
  return counts.length > 0 ? `${section.component} (${counts.join(', ')})` : section.component;
}

function readFields(props: Record<string, unknown>): ProjectedField[] {
  const fields = props['fields'];
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.filter((field): field is ProjectedField => isRecord(field));
}

function readOptions(options: unknown): string[] {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => {
      if (typeof option === 'string') {
        return option;
      }
      if (isRecord(option) && typeof option['label'] === 'string') {
        return option['label'];
      }
      return null;
    })
    .filter((label): label is string => label !== null);
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '(empty)';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '(set)';
}
