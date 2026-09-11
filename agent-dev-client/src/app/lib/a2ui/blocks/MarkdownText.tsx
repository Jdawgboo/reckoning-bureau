/**
 * Markdown answer body — the model authors answers in markdown (bold, lists,
 * links), so raw word-splitting would print the `**` syntax literally. This
 * block renders it in the stage's answer typography (Tailwind on theme tokens
 * + the `.stage-md` element styles for the generated HTML), with a
 * container-level rise-in instead of the per-word stagger (per-word animation
 * and markdown structure don't compose).
 */
import type { FC } from 'react';
import { LazyMarkdown } from '@/app/lib/components/LazyMarkdown';
import { cn } from '@/app/lib/utils';

export interface MarkdownTextProps {
  text: string;
  /** Answer typography scale: 'lg' for the page, 'base' inside a transcript
   *  turn, 'sm' for compact contexts (summaries, gallery cards). The
   *  `.stage-md` element styles are em-based, so they follow. */
  size?: 'lg' | 'base' | 'sm';
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<MarkdownTextProps['size']>, string> = {
  lg: 'text-lg',
  base: 'text-base',
  sm: 'text-sm',
};

export const MarkdownText: FC<MarkdownTextProps> = ({ text, size = 'lg', className }) => (
  <div
    className={cn('stage-md w-full animate-fadeUp leading-relaxed', SIZE_CLASS[size], className)}
  >
    <LazyMarkdown text={text} />
  </div>
);
