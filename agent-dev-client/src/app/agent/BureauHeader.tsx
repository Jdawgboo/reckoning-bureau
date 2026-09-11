/**
 * The Bureau's nameplate.
 *
 * The default header derives its monogram from the first letter of the brand
 * name, which for "The Reckoning Bureau" reads "T" — the definite article on
 * the door. This one stamps "RB" instead and adds the office line, so the bar
 * reads like the head of a letterhead rather than an app chrome.
 *
 * Mobile keeps the nav visible as a scrollable rank of stamps rather than
 * hiding it behind a hamburger: three intents fit, and a claimant looking for
 * their case file should not have to hunt for it.
 */
import type { FC } from 'react';
import { useIntl } from 'react-intl';

import { messages as libMessages } from '@/app/lib/localization/messages.ts';
import type { AgentHeaderProps } from '@/app/lib/stage/StageHeader.tsx';

export const BureauHeader: FC<AgentHeaderProps> = ({ brandName, navItems, onNavigate }) => {
  const intl = useIntl();

  return (
    <header className="flex-none border-b border-border/70 bg-background/85 px-5 pt-[env(safe-area-inset-top)] backdrop-blur-sm md:px-20">
      <div className="mx-auto flex w-full max-w-container-content items-center gap-x-4 py-3 sm:gap-x-6 sm:py-4">
        <div className="flex flex-none items-center gap-3">
          <div
            className="grid h-8 w-8 flex-none place-items-center rounded-sm bg-primary font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-primary-foreground sm:h-9 sm:w-9 sm:text-xs"
            aria-hidden="true"
          >
            RB
          </div>
          <div className="min-w-0">
            <div
              className="truncate font-display text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              translate="no"
            >
              {brandName}
            </div>
            <div className="hidden font-mono text-[0.625rem] uppercase tracking-caps text-muted-foreground-subtle sm:block">
              Office of Claims &amp; Recovery
            </div>
          </div>
        </div>

        <nav
          className="scrollbar-none -mr-3 ml-auto flex min-w-0 items-center gap-1 overflow-x-auto"
          aria-label={intl.formatMessage(libMessages.siteNavigation)}
        >
          {navItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className="flex-none cursor-pointer touch-manipulation whitespace-nowrap border-none bg-transparent px-3 py-2 font-mono text-[0.625rem] uppercase tracking-caps text-muted-foreground transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary data-[active=true]:text-primary sm:text-xs"
              data-active={item.active === true}
              onClick={() => onNavigate(item)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
};
