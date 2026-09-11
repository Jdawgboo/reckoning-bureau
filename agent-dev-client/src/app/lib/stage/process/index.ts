/**
 * Stage process pages — the interim page shown while a long-running tool
 * part executes, keyed by componentName. Thin map; each page lives in its
 * own file. Narration formatters live in `./narration.ts` (pure module).
 */
import type { FC } from 'react';
import type { ComponentContent } from '../../../../../vendor/agent-library/types/content.ts';
import { DeepResearchProcessPage } from './DeepResearch.tsx';
import { GenericProcessPage } from './GenericProcess.tsx';
import { processPageKind } from './page-registry.ts';

export type ProcessPage = FC<{ part: ComponentContent }>;

export const PROCESS_PAGES: Record<string, ProcessPage> = {
  DeepResearch: DeepResearchProcessPage,
};

/**
 * The page for an executing tool part: its dedicated page when one exists,
 * the generic working card otherwise. Null only for parts that render the
 * page themselves. The decision lives in `page-registry.ts` (pure,
 * node-testable); this maps it to components.
 */
export function processPageFor(componentName: string): ProcessPage | null {
  const kind = processPageKind(componentName);
  if (kind === 'none') {
    return null;
  }
  return kind === 'dedicated' ? PROCESS_PAGES[componentName] : GenericProcessPage;
}
