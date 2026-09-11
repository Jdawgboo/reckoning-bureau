import type { FC } from 'react';
import { Toaster } from 'sonner';

import type { Container } from './container';
import { AppRoot } from './lib/components/AppRoot';
import { StageShell } from './lib/stage/StageShell.tsx';
import { GalleryView } from './lib/a2ui/gallery/GalleryView.tsx';
import { observer } from 'mobx-react-lite';
import { SITE_CONFIG } from './agent/site-config.ts';

export const App: FC<{ container: Container }> = observer(({ container }) => {
  // Dev/design review: `?gallery=1` renders every builtin surface with
  // fixture data — standalone, no session/agent bootstrapping.
  if (new URLSearchParams(window.location.search).has('gallery')) {
    return <GalleryView />;
  }
  return (
    <AppRoot container={container}>
      <Toaster />
      <StageShell
        brandName={SITE_CONFIG.brandName}
        navItems={SITE_CONFIG.navItems}
        defaultChips={SITE_CONFIG.defaultChips}
        mode={SITE_CONFIG.mode}
        showHeader={SITE_CONFIG.showHeader}
        Header={SITE_CONFIG.Header}
        brandedArrival={SITE_CONFIG.brandedArrival}
        appearance={SITE_CONFIG.appearance}
        placeholder={SITE_CONFIG.placeholder}
      />
    </AppRoot>
  );
});
