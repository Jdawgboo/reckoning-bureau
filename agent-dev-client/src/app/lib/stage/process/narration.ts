import { messageNarration, type NarrationLine } from '../narration-line.ts';

export function narrateDeepResearch(props: Record<string, unknown>): NarrationLine {
  const currentSearch = typeof props.currentSearch === 'string' ? props.currentSearch : '';
  const searchCount = typeof props.searchCount === 'number' ? props.searchCount : 0;
  const sourceCount = Array.isArray(props.sources) ? props.sources.length : 0;
  if (!currentSearch) {
    return messageNarration('researchingInitial');
  }
  return messageNarration('researching', { currentSearch, searchCount, sourceCount });
}

export const PROCESS_NARRATIONS: Record<string, (props: Record<string, unknown>) => NarrationLine> =
  {
    DeepResearch: narrateDeepResearch,
  };
