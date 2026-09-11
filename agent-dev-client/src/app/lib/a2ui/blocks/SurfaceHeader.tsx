/**
 * Generic page header: an optional breadcrumb line, a hero title, and an
 * optional subtitle. It fills the caller and keeps every element on the
 * caller's left rail. Use-case-agnostic — callers supply all copy.
 */
import type { FC, ReactNode } from 'react';
import { cn } from '@/app/lib/utils';

export interface SurfaceHeaderProps {
  crumb?: ReactNode;
  title: string;
  subtitle?: string;
}

export const SurfaceHeader: FC<SurfaceHeaderProps> = ({ crumb, title, subtitle }) => (
  <div className="w-full">
    {crumb ? (
      <div className="mt-4.5 mb-2.5 flex w-full items-center gap-1.75 text-xs text-muted-foreground-subtle animate-fadeUp [&_b]:font-semibold [&_b]:text-muted-foreground">
        {crumb}
      </div>
    ) : null}
    <h1
      className={cn(
        'mt-0 w-full text-balance text-3xl font-bold leading-[1.16] tracking-tighter animate-fadeUp',
        subtitle ? 'mb-2' : 'mb-4',
      )}
    >
      {title}
    </h1>
    {subtitle ? (
      <p
        className="mt-0 mb-4 w-full text-base text-muted-foreground animate-fadeUp"
        style={{ animationDelay: '60ms' }}
      >
        {subtitle}
      </p>
    ) : null}
  </div>
);
