import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findActiveProcessPart, findProcessPagePart } from './active-part.ts';
import {
  ContentType,
  type AgentContent,
  type ComponentStreaming,
} from '../../../../../vendor/agent-library/types/content.ts';

function part(
  state: ComponentStreaming['state'] | undefined,
  componentName = 'DeepResearch',
  responseId = 'run-1',
): AgentContent {
  return {
    type: ContentType.Component,
    messageId: `m-${state ?? 'plain'}`,
    componentName,
    responseId,
    props: {},
    ...(state
      ? { streaming: { toolName: componentName, toolCallId: `c-${componentName}-${state}`, state } }
      : {}),
  };
}

const text: AgentContent = {
  type: ContentType.Text,
  messageId: 'm-1',
  content: 'hi',
};

describe('findActiveProcessPart', () => {
  it('returns the latest active part, skipping text and final parts', () => {
    const active = part('output-pending');
    const result = findActiveProcessPart([part('output-available'), text, active, text]);
    assert.strictEqual(result, active);
  });

  it('returns null when every part is final or has no streaming', () => {
    assert.strictEqual(
      findActiveProcessPart([part('output-available'), part('output-error')]),
      null,
    );
    assert.strictEqual(findActiveProcessPart([part(undefined), text]), null);
    assert.strictEqual(findActiveProcessPart([]), null);
  });

  it('latest wins across two active parts', () => {
    const older = part('input-streaming');
    const newer = part('output-pending');
    assert.strictEqual(findActiveProcessPart([older, newer]), newer);
  });
});

describe('findProcessPagePart — a run may upgrade its page, never downgrade it', () => {
  it('holds a finished dedicated part over a later generic part of the same run', () => {
    const research = part('output-available', 'DeepResearch');
    const search = part('output-pending', 'web_search');
    assert.strictEqual(findProcessPagePart([research, search]), research);
  });

  it('holds the dedicated part through a gap where nothing is executing', () => {
    const research = part('output-available', 'DeepResearch');
    const search = part('output-available', 'web_search');
    assert.strictEqual(findProcessPagePart([research, search]), research);
  });

  it('never resurrects a dedicated part from an earlier run', () => {
    const oldResearch = part('output-available', 'DeepResearch', 'run-1');
    const search = part('output-pending', 'web_search', 'run-2');
    assert.strictEqual(findProcessPagePart([oldResearch, search]), search);
  });

  it('an active dedicated part wins outright', () => {
    const search = part('output-available', 'web_search');
    const research = part('output-pending', 'DeepResearch');
    assert.strictEqual(findProcessPagePart([search, research]), research);
  });

  it('falls back to the active generic part when the run never had a dedicated page', () => {
    const search = part('output-pending', 'web_search');
    assert.strictEqual(findProcessPagePart([part(undefined), search]), search);
  });

  it('returns null when there is nothing to show', () => {
    assert.strictEqual(findProcessPagePart([]), null);
  });
});
