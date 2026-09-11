/**
 * Interim page for a running DeepResearch tool part (the final answer
 * replaces it). Narration formatter: `./narration.ts`.
 */
import type { FC } from 'react';
import type { ComponentContent } from '../../../../../vendor/agent-library/types/content.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import DeepResearchCard, {
  type DeepResearchArgumentsProps,
} from '@/app/lib/components/process/DeepResearch';

function toArgumentsProps(props: Record<string, unknown>): DeepResearchArgumentsProps {
  const status = props.status;
  return {
    status:
      status === 'running' || status === 'completed' || status === 'error' ? status : undefined,
    query: typeof props.query === 'string' ? props.query : undefined,
    searchCount: typeof props.searchCount === 'number' ? props.searchCount : undefined,
    searches: Array.isArray(props.searches)
      ? props.searches.filter((s): s is string => typeof s === 'string')
      : undefined,
    currentSearch: typeof props.currentSearch === 'string' ? props.currentSearch : undefined,
    sources: Array.isArray(props.sources)
      ? props.sources
          .filter(isRecord)
          .filter((source): source is { url: string; domain: string; title?: string } => {
            return typeof source.url === 'string' && typeof source.domain === 'string';
          })
      : undefined,
    resultText: typeof props.resultText === 'string' ? props.resultText : undefined,
    error: typeof props.error === 'string' ? props.error : undefined,
  };
}

export const DeepResearchProcessPage: FC<{ part: ComponentContent }> = ({ part }) => (
  <div className="stage-process-page">
    <DeepResearchCard argumentsProps={toArgumentsProps(part.props)} />
  </div>
);
