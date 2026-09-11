/**
 * TextBlock — a free-form content screen (server contract:
 * `agent-dev-server/src/bl/builtin-catalog/text-block.ts`).
 *
 * Header via the shared SurfaceHeader, prose via MarkdownText, plus an
 * ordered `blocks` array the model composes freely: headings, text passages,
 * images, buttons — any order, any count. Consecutive buttons group onto one
 * flex row.
 */
import type { FC, ReactNode } from 'react';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { MarkdownText } from '../blocks/MarkdownText.tsx';
import { SurfaceHeader } from '../blocks/SurfaceHeader.tsx';
import { useSendIntent } from '../blocks/use-send-intent.ts';
import { isRecord } from '../../util/type-guards.ts';
import { arr, optStr, str } from '../props.ts';

const PRIMARY_BUTTON =
  'pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 ' +
  'text-sm font-semibold text-primary-foreground transition duration-150 hover:opacity-90 ' +
  'active:scale-[0.97]';
const SECONDARY_BUTTON =
  'pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-md border ' +
  'border-border bg-card px-5 text-sm font-semibold text-foreground transition duration-150 ' +
  'hover:border-primary hover:text-primary active:scale-[0.97]';

interface ContentBlock {
  type: 'heading' | 'text' | 'image' | 'button';
  text?: string;
  imageUrl?: string;
  imageAlt?: string;
  caption?: string;
  label?: string;
  intent?: string;
  kind: 'primary' | 'secondary';
}

function toBlock(value: unknown): ContentBlock | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = str(value.type);
  if (type !== 'heading' && type !== 'text' && type !== 'image' && type !== 'button') {
    return null;
  }
  return {
    type,
    text: optStr(value.text),
    imageUrl: optStr(value.imageUrl),
    imageAlt: optStr(value.imageAlt),
    caption: optStr(value.caption),
    label: optStr(value.label),
    intent: optStr(value.intent),
    kind: str(value.kind) === 'secondary' ? 'secondary' : 'primary',
  };
}

/** Group consecutive button blocks so they share one flex row. */
function toSegments(blocks: ContentBlock[]): (ContentBlock | ContentBlock[])[] {
  const segments: (ContentBlock | ContentBlock[])[] = [];
  for (const block of blocks) {
    const last = segments[segments.length - 1];
    if (block.type === 'button' && Array.isArray(last)) {
      last.push(block);
    } else if (block.type === 'button') {
      segments.push([block]);
    } else {
      segments.push(block);
    }
  }
  return segments;
}

export const TextBlockSurface: FC<A2uiNodeViewProps> = ({ node }) => {
  const sendIntent = useSendIntent();
  const title = optStr(node.props.title);
  const subtitle = optStr(node.props.subtitle);
  const body = optStr(node.props.body);
  const blocks = arr(node.props.blocks)
    .map(toBlock)
    .filter((block): block is ContentBlock => block !== null);

  if (!title && !subtitle && !body && blocks.length === 0) {
    return null;
  }

  const renderSegment = (segment: ContentBlock | ContentBlock[], index: number): ReactNode => {
    if (Array.isArray(segment)) {
      return (
        <div key={index} className="my-6 flex w-full flex-wrap items-center gap-3">
          {segment.map((button) =>
            button.label && button.intent ? (
              <button
                key={button.label}
                type="button"
                className={button.kind === 'secondary' ? SECONDARY_BUTTON : PRIMARY_BUTTON}
                onClick={() => sendIntent(button.intent ?? '')}
              >
                {button.label}
              </button>
            ) : null,
          )}
        </div>
      );
    }
    if (segment.type === 'heading' && segment.text) {
      return (
        <h2
          key={index}
          className="mt-8 mb-3 w-full text-2xl font-medium tracking-tight text-foreground"
        >
          {segment.text}
        </h2>
      );
    }
    if (segment.type === 'text' && segment.text) {
      return <MarkdownText key={index} text={segment.text} />;
    }

    if (segment.type === 'image' && segment.imageUrl) {
      return (
        <figure key={index} className="my-6 w-full">
          <div className="overflow-hidden rounded-lg border border-border">
            <img
              src={segment.imageUrl}
              alt={segment.imageAlt ?? segment.caption ?? ''}
              loading="lazy"
              className="w-full object-cover"
            />
          </div>
          {segment.caption ? (
            <figcaption className="mt-2 text-center text-xs text-muted-foreground">
              {segment.caption}
            </figcaption>
          ) : null}
        </figure>
      );
    }
    return null;
  };

  return (
    <div className="w-full">
      {title ? <SurfaceHeader title={title} subtitle={subtitle} /> : null}
      {body ? <MarkdownText text={body} /> : null}
      {toSegments(blocks).map(renderSegment)}
    </div>
  );
};
