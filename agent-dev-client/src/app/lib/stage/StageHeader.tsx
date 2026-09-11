/**
 * Default site header: brand monogram + name + the intent menu, presented as
 * a full-width bar — hairline bottom border over a translucent blurred ground
 * — whose content row centers to the same column as the page content
 * (max-w-container-content + the shell's gutters), so the menu lines up with
 * the screen instead of stretching edge to edge. Agents that need a different
 * composition provide their own component via `site-config.ts` (`Header`); it
 * receives this same contract and owns its full-width bar the same way.
 *
 * On small screens the inline menu collapses into a hamburger button that
 * opens a right-side sidebar (backdrop + slide-in panel, Escape closes). The
 * sidebar is owned by this component — the shell knows nothing about it, so
 * custom headers bring their own mobile treatment.
 */
import { useEffect, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { Menu, X } from 'lucide-react';
import { useIntl } from 'react-intl';
import { cn } from '@/app/lib/utils';
import { messages } from '@/app/lib/localization/messages.ts';
import type { NavItem } from './nav-model.ts';

export interface AgentHeaderProps {
  brandName: string;
  /** Baseline nav already overlaid with the agent's `/nav` uiState. */
  navItems: NavItem[];
  /** Starts a new turn with the item's intent (acts on the live head). */
  onNavigate: (item: NavItem) => void;
}

export const StageHeader: FC<AgentHeaderProps> = ({ brandName, navItems, onNavigate }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const intl = useIntl();

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  const handleItemClick = (item: NavItem) => {
    setMenuOpen(false);
    onNavigate(item);
  };

  return (
    <header className="flex-none border-b border-border/70 bg-background/80 px-5 pt-[env(safe-area-inset-top)] backdrop-blur-sm md:px-20">
      <div className="mx-auto flex w-full max-w-container-content items-center gap-x-4 py-3 sm:gap-x-6 sm:py-4">
        <div className="flex flex-none items-center gap-2.5 sm:gap-3">
          <div className="grid h-7 w-7 flex-none place-items-center rounded-sm bg-primary font-display text-base font-semibold text-primary-foreground sm:h-8 sm:w-8 sm:text-lg">
            {brandName.charAt(0).toUpperCase()}
          </div>
          <div
            className="whitespace-nowrap font-display text-lg font-semibold tracking-tight text-foreground sm:text-xl"
            translate="no"
          >
            {brandName}
          </div>
        </div>

        {/* -mr-3 cancels the last item's own padding so the menu's text edge
            sits flush with the content column's right edge. */}
        <nav
          className="scrollbar-none hidden min-w-0 items-center gap-1 overflow-x-auto sm:-mr-3 sm:ml-auto sm:flex"
          aria-label={intl.formatMessage(messages.siteNavigation)}
        >
          {navItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className="flex-none cursor-pointer touch-manipulation whitespace-nowrap rounded-sm border-none bg-transparent px-3 py-2 text-xs font-semibold uppercase tracking-caps text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary data-[active=true]:bg-muted data-[active=true]:text-primary"
              data-active={item.active === true}
              onClick={() => onNavigate(item)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {navItems.length > 0 && (
          <button
            type="button"
            className="ml-auto grid h-9 w-9 cursor-pointer touch-manipulation place-items-center rounded-md border-none bg-transparent text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary sm:hidden"
            aria-label={intl.formatMessage(messages.openMenu)}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Mobile sidebar: backdrop + right slide-in panel. Kept mounted so both
          directions animate; hidden entirely at sm and up. Portaled to <body>:
          the header's backdrop-blur makes it the containing block for fixed
          descendants, which would pin the overlay to the header strip. */}
      {createPortal(
        <>
          <div
            aria-hidden="true"
            className={cn(
              'fixed inset-0 z-[11] bg-foreground/25 transition-opacity duration-[220ms] sm:hidden',
              menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            onPointerDown={() => setMenuOpen(false)}
          />
          <div
            className={cn(
              'fixed inset-y-0 right-0 z-[12] flex w-72 flex-col border-l border-border bg-background shadow-lift transition-transform duration-[220ms] ease-in-out sm:hidden',
              menuOpen ? 'translate-x-0' : 'translate-x-full',
            )}
          >
            <div className="flex items-center justify-between py-3 pl-5 pr-3">
              <div
                className="font-display text-base font-semibold tracking-tight text-foreground"
                translate="no"
              >
                {brandName}
              </div>
              <button
                type="button"
                className="grid h-9 w-9 cursor-pointer touch-manipulation place-items-center rounded-md border-none bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
                aria-label={intl.formatMessage(messages.closeMenu)}
                onClick={() => setMenuOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav
              className="flex flex-col gap-1 px-3 pb-4"
              aria-label={intl.formatMessage(messages.siteNavigation)}
            >
              {navItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="cursor-pointer touch-manipulation rounded-sm border-none bg-transparent px-3 py-3 text-left text-xs font-semibold uppercase tracking-caps text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary data-[active=true]:bg-muted data-[active=true]:text-primary"
                  data-active={item.active === true}
                  tabIndex={menuOpen ? 0 : -1}
                  onClick={() => handleItemClick(item)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
        </>,
        document.body,
      )}
    </header>
  );
};
