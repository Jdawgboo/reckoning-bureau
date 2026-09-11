/**
 * Centered status hero: a functional status mark + hero title + optional
 * subtitle. The check glyph is the only glyph allowed in the blocks layer —
 * it's a functional status mark, not decoration.
 */
import type { FC } from 'react';

export interface StatusHeroProps {
  title: string;
  subtitle?: string;
  tone: 'success';
}

export const StatusHero: FC<StatusHeroProps> = ({ title, subtitle }) => (
  <div className="pb-2 pt-11 px-2 text-center">
    <div className="mx-auto mb-4.5 grid h-16 w-16 animate-pop-in place-items-center rounded-full bg-success text-success-foreground motion-reduce:animate-none">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-7 w-7 fill-none stroke-current stroke-[2.4] [stroke-linecap:round] [stroke-linejoin:round]"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </div>
    <h1
      className="mt-0 mx-0 mb-1.5 text-3xl font-bold leading-[1.16] tracking-tighter text-balance"
      style={{ textAlign: 'center' }}
    >
      {title}
    </h1>
    {subtitle ? (
      <p
        className="mt-0 mx-0 mb-6.5 max-w-[58ch] text-base text-muted-foreground"
        style={{ textAlign: 'center', maxWidth: 'none', marginTop: '8px' }}
      >
        {subtitle}
      </p>
    ) : null}
  </div>
);
