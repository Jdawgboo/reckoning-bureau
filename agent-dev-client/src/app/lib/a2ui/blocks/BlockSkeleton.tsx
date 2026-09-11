/**
 * Glimmer placeholders matching each block's geometry — skeletons are the
 * latency budget, keeping first paint of the next surface under ~1.5s even
 * while props/data are still arriving. Variants mirror the block shapes:
 * `cards` → OptionCardGrid, `board` → ChoiceBoard, `form` → SmartFormFields,
 * `text` → SurfaceHeader + StreamedText.
 */
import type { FC } from 'react';
import { cn } from '@/app/lib/utils';

export interface BlockSkeletonProps {
  variant: 'cards' | 'board' | 'form' | 'text';
}

const SHIMMER_CLASS =
  'stage-shimmer-track relative overflow-hidden rounded-md bg-[var(--shimmer-a)]';

const CardsSkeleton: FC = () => (
  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
    {[0, 1, 2].map((index) => (
      <div key={index} className={SHIMMER_CLASS} style={{ height: '176px' }} />
    ))}
  </div>
);

const BoardSkeleton: FC = () => (
  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
    {[0, 1, 2].map((columnIndex) => (
      <div key={columnIndex} className="rounded-lg border border-border bg-card p-3.5">
        <div
          className={SHIMMER_CLASS}
          style={{ height: '16px', width: '60%', marginBottom: '10px' }}
        />
        <div className="flex flex-col gap-1.75">
          {[0, 1, 2].map((itemIndex) => (
            <div key={itemIndex} className={SHIMMER_CLASS} style={{ height: '44px' }} />
          ))}
        </div>
      </div>
    ))}
  </div>
);

const FormSkeleton: FC = () => (
  <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 max-w-[720px] md:grid-cols-2">
    {[0, 1].map((index) => (
      <div key={index}>
        <div
          className={SHIMMER_CLASS}
          style={{ height: '13px', width: '40%', marginBottom: '6px' }}
        />
        <div className={SHIMMER_CLASS} style={{ height: '49px' }} />
      </div>
    ))}
    <div className="data-[wide=true]:col-span-full" data-wide="true">
      <div
        className={SHIMMER_CLASS}
        style={{ height: '13px', width: '30%', marginBottom: '6px' }}
      />
      <div className={SHIMMER_CLASS} style={{ height: '96px' }} />
    </div>
  </div>
);

const LINE_CLASS =
  'stage-shimmer-track relative overflow-hidden rounded-full bg-[var(--shimmer-a)]';

const TextSkeleton: FC = () => (
  <div className="stage-skeleton-stagger mx-auto flex max-w-prose animate-fadeUp flex-col gap-3 pt-4">
    <div className={cn(LINE_CLASS, 'h-3.5 w-[90%]')} />
    <div className={cn(LINE_CLASS, 'h-3.5 w-[70%]')} />
    <div className={cn(LINE_CLASS, 'h-3.5 w-[45%]')} />
  </div>
);

export const BlockSkeleton: FC<BlockSkeletonProps> = ({ variant }) => {
  if (variant === 'cards') {
    return <CardsSkeleton />;
  }
  if (variant === 'board') {
    return <BoardSkeleton />;
  }
  if (variant === 'form') {
    return <FormSkeleton />;
  }
  return <TextSkeleton />;
};
