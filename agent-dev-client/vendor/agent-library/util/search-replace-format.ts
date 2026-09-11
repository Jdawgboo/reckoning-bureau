/**
 * Centralized constants + helpers for the SEARCH/REPLACE diff format used by our search-replace tool.
 *
 * New format (preferred):
 *   ------- SEARCH
 *   ...
 *   =======
 *   ...
 *   +++++++ REPLACE
 */

export const SR_MARKER_SEARCH = '------- SEARCH';
export const SR_MARKER_MID = '=======';
export const SR_MARKER_REPLACE = '+++++++ REPLACE';

/**
 * Marker patterns
 * - Accept 3+ marker characters (---/===/+++).
 */
export const SR_SEARCH_START_REGEX = /^[-]{3,} SEARCH$/;
export const SR_MID_REGEX = /^[=]{3,}$/;
export const SR_REPLACE_END_REGEX = /^[+]{3,} REPLACE$/;

export function srIsSearchStart(line: string): boolean {
  return SR_SEARCH_START_REGEX.test(line.trim());
}

export function srIsMidMarker(line: string): boolean {
  return SR_MID_REGEX.test(line.trim());
}

export function srIsReplaceEnd(line: string): boolean {
  return SR_REPLACE_END_REGEX.test(line.trim());
}
