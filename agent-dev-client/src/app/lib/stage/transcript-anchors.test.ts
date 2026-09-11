import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSurfaceAnchors, surfaceIdOfPart } from './transcript-anchors.ts';
import {
  ContentType,
  type AgentContent,
  type ComponentContent,
} from '../../../../vendor/agent-library/types/content.ts';
import type { MessageGroup } from '../../../../vendor/agent-library/ui/types.ts';

function surfacePart(messageId: string, surfaceId: string): AgentContent {
  return {
    type: ContentType.Component,
    messageId,
    componentName: 'Surface',
    props: { surfaceId },
  };
}

function group(id: string, responses: AgentContent[]): MessageGroup {
  return { id, request: null, responses, kind: 'agent' };
}

describe('computeSurfaceAnchors', () => {
  it('REGRESSION (components at the top): a reused surfaceId anchors at its LAST tool part', () => {
    const anchors = computeSurfaceAnchors([
      group('g0', [surfacePart('m1', 'services')]),
      group('g1', [surfacePart('m2', 'services')]),
    ]);
    assert.strictEqual(anchors.get('services'), 'm2');
  });

  it('distinct surfaces keep their own anchors', () => {
    const anchors = computeSurfaceAnchors([
      group('g0', [surfacePart('m1', 'services')]),
      group('g1', [surfacePart('m2', 'booking')]),
    ]);
    assert.strictEqual(anchors.get('services'), 'm1');
    assert.strictEqual(anchors.get('booking'), 'm2');
  });

  it('reads the surfaceId from streaming input while the tool still runs', () => {
    const part: ComponentContent = {
      type: ContentType.Component,
      messageId: 'm1',
      componentName: 'Surface',
      props: {},
      streaming: {
        toolName: 'RenderServiceCatalog',
        toolCallId: 'c1',
        state: 'output-pending',
        input: { surfaceId: 'services' },
      },
    };
    assert.strictEqual(surfaceIdOfPart(part), 'services');
  });
});
