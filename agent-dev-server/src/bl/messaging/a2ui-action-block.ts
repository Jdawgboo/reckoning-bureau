/**
 * Formats the `a2uiAction` message metadata (a visitor's click/submit on a
 * rendered screen) as a self-describing block, following the `<ui_state>`
 * precedent: injected context always carries its own one-line legend instead
 * of arriving as unexplained JSON.
 */
import { isRecord } from '../../util/type-guards.ts';

export function formatA2uiActionBlock(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return '';
  }
  return [
    '<ui_action>',
    json,
    '</ui_action>',
    'A trusted structured event from the rendered screen — the visitor clicked or submitted this on the UI (not typed text). Act on its name and context directly.',
  ].join('\n');
}
