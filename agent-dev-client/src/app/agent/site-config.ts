import './theme.css';
import { defineMessages } from 'react-intl';
import { BureauHeader } from './BureauHeader.tsx';
import type { LocalizedNavItem } from '@/app/lib/stage/nav-model.ts';
import type { AgentHeaderProps } from '@/app/lib/stage/StageHeader.tsx';
import type { FC } from 'react';
import type { MessageDescriptor } from 'react-intl';

export interface SiteConfig {
  brandName: string;
  navItems: LocalizedNavItem[];
  defaultChips: MessageDescriptor[];
  /** Page-area mode: 'site' = the latest surface IS the page; 'chat' = a
   *  scrolling transcript with inline surfaces. Same shell either way. */
  mode: 'site' | 'chat';
  /** Site header (brand + menu). Off = minimal canvas: the rail keeps
   *  history, chips keep the standing intents, the dock keeps input.
   *  Template default is off; a branded site turns it on. */
  showHeader: boolean;
  /** Custom header component. Omit for the template's default header
   *  (monogram + name + menu); provide one for a bespoke composition —
   *  it receives resolved nav items + onNavigate, so menu mechanics and
   *  the agent's /nav overlay keep working. */
  Header?: FC<AgentHeaderProps>;
  /** First-load pending state shows the brand name (shimmer) instead of the
   *  neutral text skeleton — for agents with a website identity. */
  brandedArrival?: boolean;
  /** The site's designed look — a builder decision, like a real website's.
   *  'auto' follows the visitor's OS. */
  appearance: 'light' | 'dark' | 'auto';
  /** Omnibox placeholder override. */
  placeholder?: MessageDescriptor;
}

const nav = defineMessages({
  fileLabel: { id: 'site.nav.file.label', defaultMessage: 'File a case' },
  fileIntent: {
    id: 'site.nav.file.intent',
    defaultMessage: 'I want to file a new case.',
  },
  procedureLabel: { id: 'site.nav.procedure.label', defaultMessage: 'Procedure' },
  procedureIntent: {
    id: 'site.nav.procedure.intent',
    defaultMessage: 'How does this office handle a case, start to finish?',
  },
  docketLabel: { id: 'site.nav.docket.label', defaultMessage: 'My case file' },
  docketIntent: {
    id: 'site.nav.docket.intent',
    defaultMessage: 'Show me my case file and where it stands.',
  },
});

const chips = defineMessages({
  refund: {
    id: 'site.chip.refund',
    defaultMessage: 'They refused my refund',
  },
  deposit: {
    id: 'site.chip.deposit',
    defaultMessage: 'My landlord kept the deposit',
  },
  neverCame: {
    id: 'site.chip.neverCame',
    defaultMessage: 'I paid and nothing arrived',
  },
  status: {
    id: 'site.chip.status',
    defaultMessage: 'Where does my case stand?',
  },
});

const placeholder = defineMessages({
  omnibox: {
    id: 'site.placeholder.omnibox',
    defaultMessage: 'State your grievance…',
  },
});

export const SITE_CONFIG: SiteConfig = {
  brandName: 'The Reckoning Bureau',
  navItems: [
    { label: nav.fileLabel, intent: nav.fileIntent },
    { label: nav.procedureLabel, intent: nav.procedureIntent },
    { label: nav.docketLabel, intent: nav.docketIntent },
  ],
  defaultChips: [chips.refund, chips.deposit, chips.neverCame, chips.status],
  mode: 'site',
  showHeader: true,
  Header: BureauHeader,
  brandedArrival: true,
  appearance: 'light',
  placeholder: placeholder.omnibox,
};
