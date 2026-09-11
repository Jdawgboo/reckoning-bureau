/**
 * Option-card grid: spotlight-at-pointer, hover lift, press scale, 70ms
 * stagger, whole-card tap. `featured` cards get the conic-border spin +
 * shimmer label. Generic "option" vocabulary only — the signature layer maps
 * domain records (services, plans, anything else) onto `OptionCard`.
 */
import type { FC, PointerEvent } from 'react';

export interface OptionCard {
  id: string;
  title: string;
  description?: string;
  /** Pre-formatted display value, e.g. "$80" — blocks never compute money. */
  value?: string;
  valuePrefix?: string;
  meta?: string;
  /** 0–4 duration ticks; omit to hide the tick row entirely. */
  metaTicks?: number;
  featured?: boolean;
  featuredLabel?: string;
  /** Optional media header, rendered edge-to-edge above the card content. */
  imageUrl?: string;
}

export interface OptionCardGridProps {
  options: OptionCard[];
  onSelect: (id: string) => void;
  selectLabel: string;
}

const TICK_COUNT = 4;

function handleSpotlight(event: PointerEvent<HTMLButtonElement>): void {
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--stage-mx', `${event.clientX - rect.left}px`);
  card.style.setProperty('--stage-my', `${event.clientY - rect.top}px`);
}

export const OptionCardGrid: FC<OptionCardGridProps> = ({ options, onSelect, selectLabel }) => (
  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
    {options.map((option, index) => {
      const ticks = Math.max(0, Math.min(TICK_COUNT, option.metaTicks ?? 0));
      return (
        <div
          key={option.id}
          className={`animate-fadeUp relative rounded-lg p-px ${
            option.featured === true ? 'stage-featured-border' : 'bg-border'
          }`}
          data-featured={option.featured === true}
          style={{ animationDelay: `${index * 70}ms` }}
        >
          <button
            type="button"
            className="stage-spotlight relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-lg bg-card text-left transition duration-200 hover:-translate-y-[3px] hover:shadow-lift active:-translate-y-[1px] active:scale-[0.99]"
            onClick={() => onSelect(option.id)}
            onPointerMove={handleSpotlight}
          >
            {option.imageUrl ? (
              <img
                src={option.imageUrl}
                alt=""
                className="aspect-video w-full rounded-t-lg object-cover"
              />
            ) : null}
            <div className="flex flex-1 flex-col gap-3.5 p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold tracking-tighter tabular-nums">
                  {option.valuePrefix ? (
                    <small className="mr-0.5 text-xs font-medium text-muted-foreground-subtle">
                      {option.valuePrefix}{' '}
                    </small>
                  ) : null}
                  {option.value}
                </span>
                {option.featured && option.featuredLabel ? (
                  <span className="stage-sheen relative overflow-hidden rounded-full bg-muted px-2 py-0.75 text-xs font-bold uppercase tracking-wider text-primary">
                    {option.featuredLabel}
                  </span>
                ) : null}
              </div>
              <div>
                <div className="text-base font-bold tracking-tight">{option.title}</div>
                {option.description ? (
                  <div className="text-sm leading-normal text-muted-foreground">
                    {option.description}
                  </div>
                ) : null}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="flex items-center gap-1.75">
                  {option.metaTicks !== undefined ? (
                    <span className="inline-flex gap-0.5">
                      {Array.from({ length: TICK_COUNT }, (_, tickIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length tick marks, no identity
                        <i
                          key={tickIndex}
                          data-on={tickIndex < ticks}
                          className="block h-1 w-2.25 rounded-sm bg-border not-italic data-[on=true]:bg-primary"
                        />
                      ))}
                    </span>
                  ) : null}
                  {option.meta ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {option.meta}
                    </span>
                  ) : null}
                </span>
                <span className="text-sm font-bold text-primary">{selectLabel}</span>
              </div>
            </div>
          </button>
        </div>
      );
    })}
  </div>
);
