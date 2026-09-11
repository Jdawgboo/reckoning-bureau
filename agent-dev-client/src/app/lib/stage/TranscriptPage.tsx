/**
 * Chat mode's page area: the conversation as a flowing document — the query
 * itself is each section's heading, whitespace does the turn separation,
 * markdown bodies, inline tool cards and surfaces.
 *
 * Scroll model (ported from the proven chat shell, ChatGPT-style): the last
 * turn reserves at least one viewport of height, and a NEW REQUEST scrolls
 * that turn's heading to the TOP — the answer streams into the reserved
 * space below. No bottom-chasing. Surfaces render at their `Surface` tool
 * part — the position anchor in the response flow, which also survives
 * reload; anchorless surfaces fall back to a tail section rather than
 * vanishing.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { cn } from '@/app/lib/utils';
import {
  ContentType,
  type AgentContent,
  type ComponentContent,
  type MessageGroup,
} from '@/lib/agent-library';
import { useMessagingStore } from '@/app/lib/hooks';
import { SurfaceRenderer } from '@/app/lib/a2ui/SurfaceRenderer.tsx';
import { MarkdownText } from '@/app/lib/a2ui/blocks/MarkdownText.tsx';
import { AttachmentChip } from '@/app/lib/components/input/AttachmentChip';
import { splitAttachmentMarker } from '@/app/lib/files/attachment-marker.ts';
import DeepResearch from '@/app/lib/components/process/DeepResearch';
import Subagent from '@/app/lib/components/process/Subagent';
import Sources from '@/app/lib/components/content/Sources.tsx';
import { componentRenderers } from '@/app/agent/renderers';
import { computeSurfaceAnchors, surfaceIdOfPart } from './transcript-anchors.ts';

const PIN_TOP_MARGIN_PX = 8;
const COMPONENT_SCROLL_MARGIN_PX = 100;

/** Inline hosts for tool parts: process components + the builder's chat
 *  registry. `FC<any>` matches the registry's own typing — entries vary in
 *  which of {argumentsProps, toolPart} they consume. */
// biome-ignore lint/suspicious/noExplicitAny: registry contract, see above.
const INLINE_HOSTS: Record<string, FC<any>> = {
  DeepResearch,
  Subagent,
  Sources,
  ...componentRenderers,
};

const TranscriptToolCard: FC<{ part: ComponentContent }> = ({ part }) => {
  const Host = INLINE_HOSTS[part.componentName];
  if (Host) {
    return <Host argumentsProps={part.props} toolPart={part} />;
  }
  const fallback = part.fallbackMarkdown ?? part.fallbackText;
  if (fallback) {
    return <MarkdownText text={fallback} size="base" />;
  }
  return null;
};

function requestLine(request: AgentContent | null): string | null {
  if (!request || request.type !== ContentType.Text) {
    return null;
  }
  if (request.hidden || !request.content) {
    return null;
  }
  return request.content;
}

export const TranscriptPage: FC = observer(() => {
  const messagesStore = useMessagingStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const requestCountRef = useRef(0);
  const [reservedHeight, setReservedHeight] = useState(0);

  const scrollParent = () =>
    rootRef.current?.closest('[data-stage-scroll]') ?? document.scrollingElement;

  // The last turn's reserve: at max scroll the viewport's bottom is occupied
  // by everything that sits BELOW the section — the scroll container's bottom
  // padding (dock clearance, pb-48) and this root's own bottom padding — so
  // the section gets clientHeight minus both, minus the same 8px breathing
  // room the request-pin uses. Result: scrolling to the very bottom lands the
  // request heading 8px from the top (max scroll == pinned position), and the
  // turn fills the whole area above the dock.
  useLayoutEffect(() => {
    const measure = () => {
      const parent = scrollParent();
      const root = rootRef.current;
      if (parent && root) {
        const page = root.closest('[data-stage-page]') ?? parent;
        const pagePb = Number.parseFloat(window.getComputedStyle(page).paddingBottom);
        const rootPb = Number.parseFloat(window.getComputedStyle(root).paddingBottom);
        setReservedHeight(Math.max(0, parent.clientHeight - pagePb - rootPb - PIN_TOP_MARGIN_PX));
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const groups = messagesStore.groupedMessages;

  // A new request pins its heading to the top; the reserved min-height below
  // is where the answer streams in.
  const requestCount = groups.filter((group) => requestLine(group.request) !== null).length;
  useEffect(() => {
    if (requestCount <= requestCountRef.current) {
      requestCountRef.current = requestCount;
      return;
    }
    requestCountRef.current = requestCount;
    const parent = scrollParent();
    const sections = rootRef.current?.querySelectorAll('[data-turn-section]');
    const last = sections?.[sections.length - 1];
    if (parent && last) {
      window.setTimeout(() => {
        const y =
          last.getBoundingClientRect().top -
          parent.getBoundingClientRect().top +
          parent.scrollTop -
          PIN_TOP_MARGIN_PX;
        parent.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }, 50);
    }
  }, [requestCount]);

  // An updated component (agent re-rendered a screen in place) scrolls into view.
  const updatedComponentId = messagesStore.lastUpdatedComponentId;
  useEffect(() => {
    if (!updatedComponentId) {
      return;
    }
    const parent = scrollParent();
    const element = rootRef.current?.querySelector(`[data-cid="${updatedComponentId}"]`);
    if (parent && element) {
      window.setTimeout(() => {
        const y =
          element.getBoundingClientRect().top -
          parent.getBoundingClientRect().top +
          parent.scrollTop -
          COMPONENT_SCROLL_MARGIN_PX;
        parent.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }, 100);
    }
  }, [updatedComponentId]);

  const liveSurfaceIds = new Set(messagesStore.a2uiSurfaces.surfaces.keys());

  const lastAnchorBysurfaceId = computeSurfaceAnchors(groups);

  const renderedSurfaceIds = new Set<string>();

  const sections = groups.map((group: MessageGroup, index: number) => {
    const rawRequest = requestLine(group.request);
    const split = rawRequest === null ? null : splitAttachmentMarker(rawRequest);
    const request = split ? split.text : null;
    const attachedNames = split?.filenames ?? [];
    const attachedFiles =
      rawRequest === null ? undefined : messagesStore.attachmentsForRequest(rawRequest);
    const items: ReactNode[] = [];
    for (const content of group.responses) {
      if (content.type === ContentType.Text) {
        if (content.isReasoning || messagesStore.isSubagentScoped(content.messageId)) {
          continue;
        }
        if (content.content) {
          items.push(
            <MarkdownText key={`t-${content.messageId}`} text={content.content} size="base" />,
          );
        }
        continue;
      }
      if (content.type !== ContentType.Component) {
        continue;
      }
      const part = content as ComponentContent;
      if (part.componentName === 'Surface') {
        const surfaceId = surfaceIdOfPart(part);
        if (
          !surfaceId ||
          !liveSurfaceIds.has(surfaceId) ||
          lastAnchorBysurfaceId.get(surfaceId) !== content.messageId
        ) {
          continue;
        }
        renderedSurfaceIds.add(surfaceId);
        items.push(
          <div
            key={`s-${surfaceId}`}
            className="rounded-lg border border-border bg-card px-5.5 py-5 shadow-elevated"
            data-cid={surfaceId}
          >
            <SurfaceRenderer surfaceId={surfaceId} />
          </div>,
        );
        continue;
      }
      items.push(
        <div key={`c-${content.messageId}`} data-cid={content.messageId}>
          <TranscriptToolCard part={part} />
        </div>,
      );
    }

    return { key: group.id, anchorIndex: index, request, attachedNames, attachedFiles, items };
  });

  // Safety net for surfaces with no anchoring tool part in the transcript
  // (sessions predating the Surface tool part, or resync edge cases) — render
  // at the end instead of vanishing.
  const tailSurfaceIds = [...liveSurfaceIds].filter((id) => !renderedSurfaceIds.has(id));

  return (
    <div ref={rootRef} className="flex flex-col gap-10 pb-6">
      {sections.map((section, index) => (
        <section
          key={section.key}
          id={`turn-${section.anchorIndex}`}
          // A headless first turn (the welcome greeting — its request is the
          // hidden open message) has no request heading to carry the top
          // rhythm, so it gets its own headroom.
          className={cn('flex flex-col gap-3.5', index === 0 && !section.request && 'pt-10')}
          data-turn-section
          style={index === sections.length - 1 ? { minHeight: reservedHeight } : undefined}
        >
          {section.request && (
            <h2 className="pt-3 text-xl font-bold tracking-tighter text-foreground">
              {section.request}
            </h2>
          )}
          {section.attachedNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {section.attachedNames.map((name) => {
                const file = section.attachedFiles?.find((f) => f.name === name);
                if (file?.type.startsWith('image/')) {
                  return (
                    <img
                      key={name}
                      src={`data:${file.type};base64,${file.data}`}
                      alt={name}
                      className="h-24 w-24 rounded-md border border-border object-cover"
                    />
                  );
                }
                return <AttachmentChip key={name} name={name} mediaType={file?.type} />;
              })}
            </div>
          )}
          {section.items}
        </section>
      ))}
      {tailSurfaceIds.length > 0 && (
        <section className="flex flex-col gap-3.5" data-turn-section>
          {tailSurfaceIds.map((surfaceId) => (
            <div
              key={surfaceId}
              className="rounded-lg border border-border bg-card px-5.5 py-5 shadow-elevated"
              data-cid={surfaceId}
            >
              <SurfaceRenderer surfaceId={surfaceId} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
});
