/**
 * Turn rail (right edge, where the scroll lives): one equal-width hairline
 * per user request. Hovering anywhere on the rail targets the line nearest
 * the pointer (no need to hit a 2px hairline) and reveals its peek card
 * (request + clamped response preview); the current turn is accented.
 * Keyboard accessible: each bar is a real `<button>`, and its peek is
 * revealed on `:focus-visible` too.
 *
 * Scrubbing: the whole rail is a press-and-drag surface — pointer down
 * anywhere selects the nearest line, and dragging while pressed follows the
 * pointer. Individual clicks still work.
 */
import { useRef, useState, type FC, type PointerEvent } from 'react';
import type { TurnEntry } from './turn-index.ts';
import { nearestRailRowByY, railWindowOffset, type RailRowPosition } from './rail-scrub.ts';
import { splitAttachmentMarker } from '@/app/lib/files/attachment-marker.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export interface TurnRailProps {
  turns: TurnEntry[];
  /** Index of the turn currently shown in the page area; -1 if none selected. */
  currentIndex: number;
  onSelect: (index: number) => void;
}

export const TurnRail: FC<TurnRailProps> = ({ turns, currentIndex, onSelect }) => {
  const intl = useIntl();
  const railRef = useRef<HTMLElement | null>(null);
  const scrubbing = useRef(false);
  const [hoverTurnId, setHoverTurnId] = useState<string | null>(null);
  const offset = railWindowOffset(turns.length);
  const visibleTurns = turns.slice(offset);

  const rowPositions = (): RailRowPosition[] => {
    const rail = railRef.current;
    if (!rail) {
      return [];
    }

    return [...rail.querySelectorAll<HTMLElement>('[data-rail-turn]')].flatMap((row) => {
      const turnId = row.dataset.railTurn;
      const turnIndex = Number(row.dataset.railIndex);
      if (!turnId || !Number.isInteger(turnIndex)) {
        return [];
      }
      const rect = row.getBoundingClientRect();
      return [{ turnId, turnIndex, centerY: rect.top + rect.height / 2 }];
    });
  };

  const nearestRow = (clientY: number): RailRowPosition | undefined =>
    nearestRailRowByY(rowPositions(), clientY);

  const selectNearest = (clientY: number) => {
    const row = nearestRow(clientY);
    setHoverTurnId(row?.turnId ?? null);
    if (row && row.turnIndex !== currentIndex) {
      onSelect(row.turnIndex);
    }
  };

  // The peek card overhangs the rail to the left; while the pointer is on it,
  // freeze the hover target so the card doesn't flip away mid-read.
  const isOverPeekCard = (event: PointerEvent<HTMLElement>): boolean =>
    event.target instanceof Element && event.target.closest('[role="tooltip"]') !== null;

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (turns.length === 0 || isOverPeekCard(event)) {
      return;
    }
    scrubbing.current = true;
    railRef.current?.setPointerCapture(event.pointerId);
    selectNearest(event.clientY);
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (scrubbing.current) {
      selectNearest(event.clientY);
      return;
    }
    if (isOverPeekCard(event)) {
      return;
    }
    setHoverTurnId(nearestRow(event.clientY)?.turnId ?? null);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLElement>) => {
    scrubbing.current = false;
    railRef.current?.releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (!scrubbing.current) {
      setHoverTurnId(null);
    }
  };

  return (
    <nav
      ref={railRef}
      className="fixed inset-y-0 right-0 z-[6] flex w-7 flex-col justify-center gap-2.5 touch-none cursor-pointer pr-2 md:w-14 md:gap-3 md:pr-4.5"
      aria-label={intl.formatMessage(messages.requestHistory)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerLeave}
    >
      {visibleTurns.map((turn, index) => {
        const label = turn.home
          ? intl.formatMessage(messages.home)
          : splitAttachmentMarker(turn.request).text;
        const absoluteIndex = index + offset;
        return (
          <div
            className="group relative flex items-center justify-end"
            data-rail-turn={turn.id}
            data-rail-index={absoluteIndex}
            data-hovered={turn.id === hoverTurnId}
            key={turn.id}
          >
            <button
              type="button"
              className="peer relative block h-0.5 w-5 origin-right cursor-pointer rounded-full border-0 bg-muted-foreground-subtle p-0 opacity-50 transition duration-[180ms] data-[current=true]:h-[3px] data-[current=true]:bg-primary data-[current=true]:opacity-100 group-data-[hovered=true]:scale-x-[1.6] group-data-[hovered=true]:bg-foreground group-data-[hovered=true]:opacity-100 group-data-[hovered=true]:data-[current=true]:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              data-current={absoluteIndex === currentIndex}
              aria-label={intl.formatMessage(messages.turn, {
                number: absoluteIndex + 1,
                label,
              })}
              onClick={() => onSelect(absoluteIndex)}
            />
            <div
              className="absolute right-8 top-1/2 z-[7] w-75 translate-x-1.5 -translate-y-1/2 rounded-[14px] border border-border bg-card px-3.75 py-3.25 opacity-0 pointer-events-none shadow-lift transition duration-[160ms] group-data-[hovered=true]:translate-x-0 group-data-[hovered=true]:opacity-100 group-data-[hovered=true]:pointer-events-auto peer-focus-visible:translate-x-0 peer-focus-visible:opacity-100 peer-focus-visible:pointer-events-auto md:right-11"
              role="tooltip"
            >
              <div className="mb-1.25 text-sm font-bold">{label}</div>
              <div className="line-clamp-3 text-sm leading-[1.45] text-muted-foreground">
                {turn.responsePreview}
              </div>
              <div className="mt-2 text-xs font-semibold text-primary">
                {intl.formatMessage(messages.browseTurns)}
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
};
