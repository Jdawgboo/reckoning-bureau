import {
  ContentType,
  type ComponentContent,
} from '../../../../vendor/agent-library/types/content.ts';
import type { MessageGroup } from '../../../../vendor/agent-library/ui/types.ts';

/** Surface id carried by a `Surface` tool part: `uiProps` once execution
 *  finished, the streaming input while it runs. */
export function surfaceIdOfPart(part: ComponentContent): string | null {
  const fromProps = part.props?.surfaceId;
  if (typeof fromProps === 'string') {
    return fromProps;
  }
  const fromInput = part.streaming?.input?.surfaceId;
  return typeof fromInput === 'string' ? fromInput : null;
}

/**
 * Upsert semantics: the agent REUSES a surfaceId to update a screen, and only
 * one live record exists per id — so a surface belongs to the turn that most
 * recently rendered it. Maps each surfaceId to the messageId of its LAST
 * anchoring tool part; the transcript renders the surface only there.
 */
export function computeSurfaceAnchors(groups: MessageGroup[]): Map<string, string> {
  const lastAnchor = new Map<string, string>();
  for (const group of groups) {
    for (const content of group.responses) {
      if (content.type !== ContentType.Component) {
        continue;
      }
      const part = content as ComponentContent;
      if (part.componentName !== 'Surface') {
        continue;
      }
      const surfaceId = surfaceIdOfPart(part);
      if (surfaceId && content.messageId) {
        lastAnchor.set(surfaceId, content.messageId);
      }
    }
  }
  return lastAnchor;
}
