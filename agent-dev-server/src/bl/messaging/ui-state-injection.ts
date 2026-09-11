/**
 * Per-turn `uiState` injection.
 *
 * Reads the session's `uiState` StateTree node and renders it as a compact,
 * delimited block appended to the user turn (NOT the system prompt — keeping the
 * volatile state after the cached system prefix preserves prompt caching). This
 * is how the agent sees the current A2UI data model / UI state each turn.
 *
 * Standalone + node-loadable (narrow structural `UiStateReadable` param that
 * StateTree satisfies), so the read/format logic is unit-testable without
 * MessagingService's runtime graph.
 */

import { isRecord } from '../../util/type-guards.ts';

/** The narrow slice of StateTree this needs; `StateTree` satisfies it structurally. */
export interface UiStateReadable {
  get(path: string): Promise<unknown>;
}

/** Cap the injected block so a large data model can't blow the turn context. */
const MAX_UI_STATE_CHARS = 4000;

export function formatUiStateBlock(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return '';
  }
  let json: string;
  try {
    json = JSON.stringify(deepSortKeys(value));
  } catch {
    return '';
  }
  if (json.length > MAX_UI_STATE_CHARS) {
    json = `${json.slice(0, MAX_UI_STATE_CHARS)}…(truncated)`;
  }
  return [
    '<ui_state>',
    json,
    '</ui_state>',
    'Current UI state the user is interacting with (from the rendered interface, updated on field blur). Context only; do not echo it verbatim. Password and card values are withheld — absent means withheld, not blank.',
  ].join('\n');
}

export async function readUiStateBlock(
  stateTree: UiStateReadable | null,
  sessionKey: string | undefined,
): Promise<string> {
  if (!stateTree || !sessionKey) {
    return '';
  }
  let value: unknown;
  try {
    value = await stateTree.get(`/sessions/${sessionKey}/uiState`);
  } catch {
    return '';
  }
  return formatUiStateBlock(value);
}

/** Stable serialization — sort object keys recursively so equal state yields
 *  an identical block regardless of write order (cache-friendly, testable). */
function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, deepSortKeys(value[key])]),
    );
  }
  return value;
}
