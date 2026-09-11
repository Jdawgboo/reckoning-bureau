/**
 * The top nav is the site's standing intents, sourced from `uiState./nav`
 * (agent-writable via any tool's `dataModel` merge) and falling back to the
 * template's baseline `navItems` when the overlay is absent, empty, or
 * malformed. Pure and node-loadable — no MobX/React dependency.
 */
import { isRecord } from '../util/type-guards.ts';
import type { MessageDescriptor } from 'react-intl';

export interface LocalizedNavItem {
  label: MessageDescriptor;
  intent: MessageDescriptor;
  active?: boolean;
}

export interface NavItem {
  label: string;
  intent: string;
  active?: boolean;
}

/** Validates and narrows one candidate `/nav` entry to a `NavItem`, or
 *  returns `null` when `label`/`intent` are missing or the wrong type. */
function toNavItem(value: unknown): NavItem | null {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.intent !== 'string') {
    return null;
  }
  const item: NavItem = { label: value.label, intent: value.intent };
  if (typeof value.active === 'boolean') {
    item.active = value.active;
  }
  return item;
}

/**
 * `uiState./nav` (validated) overlaid on the template baseline; malformed
 * entries dropped individually; baseline used when `/nav` is absent, not an
 * array, empty, or contains no valid entries.
 */
export function resolveNavItems(uiStateNav: unknown, templateItems: NavItem[]): NavItem[] {
  if (!Array.isArray(uiStateNav) || uiStateNav.length === 0) {
    return templateItems;
  }

  const validated: NavItem[] = [];
  for (const entry of uiStateNav) {
    const item = toNavItem(entry);
    if (item) {
      validated.push(item);
    }
  }

  return validated.length > 0 ? validated : templateItems;
}
