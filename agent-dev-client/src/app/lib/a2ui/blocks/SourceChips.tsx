/**
 * A wrapped row of subtle source chips. Generic — a title string per chip,
 * nothing else.
 */
import type { FC } from 'react';

export interface SourceChip {
  title: string;
}

export interface SourceChipsProps {
  sources: SourceChip[];
}

export const SourceChips: FC<SourceChipsProps> = ({ sources }) => {
  if (sources.length === 0) {
    return null;
  }
  return (
    <div
      className="animate-fadeUp mt-5.5 flex flex-wrap gap-1.75"
      style={{ animationDelay: '200ms' }}
    >
      {sources.map((source) => (
        <span
          key={source.title}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.25 text-xs text-muted-foreground"
        >
          {source.title}
        </span>
      ))}
    </div>
  );
};
