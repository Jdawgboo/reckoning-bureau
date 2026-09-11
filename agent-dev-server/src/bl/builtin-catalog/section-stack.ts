/**
 * SectionStack — composite screen contract: ONE RenderSectionStack call
 * composes several existing components onto one surface. Built via a factory
 * at registry-assembly time so the section enum, validation, fallback, and
 * node expansion stay derived from whatever contracts the agent ships
 * (agent screens + platform builtins). Compiles to a REAL A2UI adjacency
 * list (Column root + children) — no runtime component of its own.
 * Pattern credit: PROD agent m0yiv1jsbo7a (agent-zone original).
 */
import {
  resolvePendingAction,
  validateComponentProps,
  type ComponentContract,
  type FallbackLocalization,
  type PropSpec,
} from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import type { A2uiComponentNode } from '../../../vendor/agentplace-a2ui/types.ts';
import { settledArrayPrefix } from '../../../vendor/agentplace-a2ui/partial-input.ts';
import { isRecord } from '../../util/type-guards.ts';

export const SECTION_STACK_NAME = 'SectionStack';

const STACK_ROOT_COMPONENT = 'Column';

interface StackSection {
  component: string;
  props: Record<string, unknown>;
}

function readSections(props: Record<string, unknown>): StackSection[] {
  const raw = Array.isArray(props.sections) ? props.sections : [];
  const sections: StackSection[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    sections.push({
      component: typeof entry.component === 'string' ? entry.component : '',
      props: isRecord(entry.props) ? entry.props : {},
    });
  }
  return sections;
}

function validateSections(
  subContracts: Record<string, ComponentContract>,
  props: Record<string, unknown>,
): string[] {
  const sections = readSections(props);
  if (sections.length === 0) {
    return ['sections must be a non-empty array of {component, props} objects.'];
  }
  const problems: string[] = [];
  const publishOwners = new Map<string, string>();
  sections.forEach((section, index) => {
    const label = `Section ${index + 1}`;
    if (section.component === SECTION_STACK_NAME) {
      problems.push(`${label}: a SectionStack cannot nest another SectionStack.`);
      return;
    }
    const sub = subContracts[section.component];
    if (!sub) {
      const valid = Object.keys(subContracts)
        .filter((name) => name !== SECTION_STACK_NAME)
        .join(', ');
      problems.push(`${label}: unknown component "${section.component}". Valid: ${valid}.`);
      return;
    }
    for (const problem of validateComponentProps(sub, section.props)) {
      problems.push(`${label} (${section.component}): ${problem}`);
    }
    for (const key of Object.keys(sub.publishes ?? {})) {
      const owner = publishOwners.get(key);
      if (owner) {
        problems.push(
          `${label} (${section.component}) writes ${key}, already written by ${owner} — ` +
            'at most one such interactive section per page.',
        );
      } else {
        publishOwners.set(key, section.component);
      }
    }
  });
  return problems;
}

/**
 * A section's identity, as opposed to its position. Two renders of the same
 * screen must reuse the same node id so React reconciles by key and whatever
 * the visitor typed survives; two DIFFERENT screens must not, or the DOM is
 * reused and typed values cross between unrelated forms.
 *
 * Identity comes from the contract's own key fields where it has them — a
 * form's field ids are `required` and are already the data-model binding key
 * (`/form/{id}`), so DOM identity and data identity agree. Components with no
 * such key fall back to an ordinal scoped to their component name, so
 * inserting a section of one kind does not renumber sections of another.
 */
function identityKey(section: {
  component: string;
  props?: Record<string, unknown>;
}): string | null {
  const fields = section.props?.['fields'];
  if (!Array.isArray(fields)) {
    return null;
  }
  const ids = fields
    .map((field) => (isRecord(field) ? field['id'] : undefined))
    .filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? ids.join(',') : null;
}

/** Short stable digest — ids travel on the wire and show up in logs. */
function shortHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function sectionNodeId(
  section: { component: string; props?: Record<string, unknown> },
  index: number,
  componentsInOrder: readonly string[],
): string {
  const key = identityKey(section);
  if (key) {
    return `${section.component}-${shortHash(key)}`;
  }
  let ordinal = 0;
  for (let i = 0; i < index && i < componentsInOrder.length; i++) {
    if (componentsInOrder[i] === section.component) {
      ordinal++;
    }
  }
  return `${section.component}-${ordinal}`;
}

function composeSections(props: Record<string, unknown>): A2uiComponentNode[] {
  const sections = readSections(props);
  const order = sections.map((section) => section.component);
  const ids = sections.map((section, index) => sectionNodeId(section, index, order));
  return [
    { id: 'root', component: STACK_ROOT_COMPONENT, children: ids },
    ...sections.map((section, index) => ({
      ...section.props,
      id: ids[index] as string,
      component: section.component,
    })),
  ];
}

/**
 * Progressive composition for streamed input: a leading run of `sections`
 * counts as complete once a LATER element has started in the parsed array
 * (the `elementStream` completeness test — see
 * docs/superpowers/specs/2026-07-25-progressive-surface-streaming.md §3).
 * The last-seen element is never counted complete on its own — a partial parse
 * gives no signal that it has stopped growing.
 *
 * Delegates displacement detection to `settledArrayPrefix`.
 */
function composePartialSections(props: Record<string, unknown>): { nodes: A2uiComponentNode[] } {
  const sections = readSections(props);
  const settled = settledArrayPrefix(sections, (section) => section.component.length > 0);
  return { nodes: composeSections({ sections: settled }) };
}

function genericSectionFallback(component: string, props: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.length > 0) {
      bits.push(`${key}: ${value}`);
    }
    if (bits.length >= 4) {
      break;
    }
  }
  return `**${component}**${bits.length > 0 ? `\n${bits.join('\n')}` : ''}`;
}

function sectionsFallback(
  subContracts: Record<string, ComponentContract>,
  props: Record<string, unknown>,
  localization?: FallbackLocalization,
): string {
  const parts = readSections(props).map((section) => {
    const sub = subContracts[section.component];
    if (sub?.fallbackTemplate) {
      try {
        return sub.fallbackTemplate(section.props, localization);
      } catch {
        return genericSectionFallback(section.component, section.props);
      }
    }
    return genericSectionFallback(section.component, section.props);
  });
  return parts.filter((part) => part.length > 0).join('\n\n---\n\n');
}

export function createSectionStackContract(
  subContracts: Record<string, ComponentContract>,
): ComponentContract {
  const stackable = Object.keys(subContracts).filter((name) => name !== SECTION_STACK_NAME);
  const sectionItems: Record<string, PropSpec> = {
    component: {
      type: 'string',
      required: true,
      enum: stackable,
      description: 'Which component this section renders.',
    },
    props: {
      type: 'object',
      required: true,
      description:
        "This component's own contract props ONLY, exactly as its Render tool defines them " +
        '(same names, same shapes). Never include surfaceId, dataModel, chips, nav or ' +
        'fallbackMarkdown here. At most ONE interactive section of a given kind (one Form, ' +
        "one OptionGrid, one ChoiceBoard) per page — they share the page's data model.",
    },
  };
  return {
    component: SECTION_STACK_NAME,
    purpose:
      'Composes complete, independently useful components into ONE surface, top-to-bottom in ' +
      'one call. Use when blocks belong together but do not need one tightly coupled contract; use ' +
      'one custom component when they do. Never use multiple Render calls to compose a surface. ' +
      'Put any heading in the first section. ' +
      'With a live viewer on a new surface, completed leading sections can appear while later ' +
      'sections are still being written; order sections accordingly.',
    props: {
      sections: {
        type: 'array',
        required: true,
        description:
          'The blocks of the page, rendered top-to-bottom in this order. 2-4 sections is the ' +
          'sweet spot. Never nest a SectionStack inside a SectionStack.',
        items: sectionItems,
      },
    },
    publishes: {},
    actions: {},
    validateProps: (props) => validateSections(subContracts, props),
    compose: composeSections,
    composePartial: composePartialSections,
    fallbackTemplate: (props, localization) => sectionsFallback(subContracts, props, localization),
    pendingAction: (props) => {
      for (const section of readSections(props)) {
        const sub = subContracts[section.component];
        const result = sub ? resolvePendingAction(sub, section.props) : null;
        if (result) {
          return result;
        }
      }
      return null;
    },
  };
}
