/**
 * What each builtin component renders as a pressable control, read off the props it was
 * given. Platform-owned: the caption and per-item context live in those props, while the
 * dispatch is written in the client component, and no single place holds both.
 *
 * Deliberately not a `ComponentContract` field — agents extend that type, and nothing about
 * authoring a screen should depend on this.
 */

import { isRecord } from '../util/type-guards.ts';

export interface PressTarget {
  caption: string;
  /** Declared action this control dispatches, or null when it sends a plain message. */
  action: string | null;
  context?: Record<string, unknown>;
  /** Message text the press produces. Defaults to the action name, as `api.dispatch` sends. */
  message?: string;
  /** Set when the control is on screen but not pressable, with the reason. */
  unavailable?: string;
}

type Projection = (props: Record<string, unknown>) => PressTarget[];

function text(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return typeof value === 'string' ? value : '';
}

function records(props: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = props[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const form: Projection = (props) =>
  records(props, 'fields').length === 0
    ? []
    : [{ caption: text(props, 'submitLabel') || 'Submit', action: 'submitForm', context: {} }];

const summary: Projection = (props) => {
  if (records(props, 'lines').length === 0) {
    return [];
  }
  const caption = text(props, 'commitLabel') || 'Confirm';
  const unavailable = text(props, 'status') === 'confirmed' ? 'already confirmed' : undefined;
  return [{ caption, action: 'commit', context: {}, ...(unavailable ? { unavailable } : {}) }];
};

const optionGrid: Projection = (props) =>
  records(props, 'options').flatMap((option) => {
    const id = option['id'];
    const name = option['name'];
    if (typeof id !== 'string' || typeof name !== 'string') {
      return [];
    }
    return [{ caption: name, action: 'selectOption', context: { id, name } }];
  });

const choiceBoard: Projection = (props) =>
  records(props, 'columns').flatMap((column) =>
    records(column, 'items').flatMap((item) => {
      const id = item['id'];
      const label = item['label'];
      if (typeof id !== 'string' || typeof label !== 'string') {
        return [];
      }
      return [
        {
          caption: label,
          action: 'selectChoice',
          context: { id, label },
          ...(item['disabled'] === true ? { unavailable: 'disabled' } : {}),
        },
      ];
    }),
  );

// Rows are inert unless `selectable`; the index fallback for a missing id mirrors `toItems`.
const list: Projection = (props) =>
  props['selectable'] !== true
    ? []
    : records(props, 'items').map((item, index) => {
        const rawId = item['id'];
        const id = typeof rawId === 'string' ? rawId : String(index);
        const title = text(item, 'title');
        return { caption: title, action: 'selectItem', context: { id, title } };
      });

// A block button sends its `intent` as an ordinary message: `useSendIntent`, not `dispatch`.
const textBlock: Projection = (props) =>
  records(props, 'blocks').flatMap((block) => {
    const { label, intent } = block;
    if (block['type'] !== 'button' || typeof label !== 'string' || !label) {
      return [];
    }
    if (typeof intent !== 'string' || !intent) {
      return [];
    }
    return [{ caption: label, action: null, message: intent }];
  });

export const PRESS_TARGETS: Record<string, Projection> = {
  Form: form,
  Summary: summary,
  OptionGrid: optionGrid,
  ChoiceBoard: choiceBoard,
  List: list,
  TextBlock: textBlock,
};
