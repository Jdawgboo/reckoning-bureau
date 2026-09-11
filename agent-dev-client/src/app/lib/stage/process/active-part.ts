import {
  ContentType,
  type AgentContent,
  type ComponentContent,
} from '../../../../../vendor/agent-library/types/content.ts';
import { processPageKind } from './page-registry.ts';

const ACTIVE_STATES = new Set(['input-streaming', 'input-available', 'output-pending']);

/** Latest tool part still executing — the source for the stage's process
 *  page and live narration. Null once every part reached a final state. */
export function findActiveProcessPart(contents: AgentContent[]): ComponentContent | null {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.type !== ContentType.Component) {
      continue;
    }
    const part = content as ComponentContent;
    const state = part.streaming?.state;
    if (state && ACTIVE_STATES.has(state)) {
      return part;
    }
  }
  return null;
}

/**
 * The part whose page the stage shows while a run works. Within one run the
 * page may upgrade (generic working card to a dedicated page) but never
 * downgrade: once a dedicated part exists, it stays the page — through later
 * generic tools and through gaps where nothing is executing — so the screen
 * never collapses rich progress into a bare title mid-run. A new run starts
 * from scratch; a finished run's page is retired by the stage's own pending
 * gate, not here.
 */
export function findProcessPagePart(contents: AgentContent[]): ComponentContent | null {
  const active = findActiveProcessPart(contents);
  const currentRunId = active ? active.responseId : latestToolPart(contents)?.responseId;
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.type !== ContentType.Component) {
      continue;
    }
    const part = content as ComponentContent;
    if (!part.streaming || part.responseId !== currentRunId) {
      continue;
    }
    if (processPageKind(part.componentName) === 'dedicated') {
      return part;
    }
  }
  return active;
}

function latestToolPart(contents: AgentContent[]): ComponentContent | null {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.type === ContentType.Component && (content as ComponentContent).streaming) {
      return content as ComponentContent;
    }
  }
  return null;
}
