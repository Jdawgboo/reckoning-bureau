/**
 * AG-UI CUSTOM event names carrying A2UI surface messages. Reference as
 * constants, never string literals.
 */

export const A2UI_EVENT_PREFIX = 'agentplace.a2ui.';

export const A2UI_EVENT_NAMES = {
  createSurface: 'agentplace.a2ui.createSurface',
  updateComponents: 'agentplace.a2ui.updateComponents',
  deleteSurface: 'agentplace.a2ui.deleteSurface',
} as const;

export function isA2uiEventName(name: string): boolean {
  return name.startsWith(A2UI_EVENT_PREFIX);
}
