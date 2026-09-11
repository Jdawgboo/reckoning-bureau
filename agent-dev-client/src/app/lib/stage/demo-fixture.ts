/**
 * Dev preview hook: `window.__a2uiDemo()` pushes a neutral fixture surface
 * through the real store path so platform developers can eyeball the surface
 * pipeline without a running agent. Clean template: previews a builtin
 * (Chart) — the agent's own catalog is empty until the builder fills it.
 * Not shipped behavior; wired in `StageShell` but only fires on demand.
 */
import { useEffect } from 'react';
import { useMessagingStore } from '@/app/lib/hooks';
import { A2UI_EVENT_NAMES } from '../../../../vendor/agentplace-a2ui/event-names.ts';

declare global {
  interface Window {
    __a2uiDemo?: () => void;
  }
}

export function useA2uiDemoHook(): void {
  const messagesStore = useMessagingStore();

  useEffect(() => {
    const pushBuiltinPreview = () => {
      const surfaces = messagesStore.a2uiSurfaces;
      surfaces.applySurfaceEvent(A2UI_EVENT_NAMES.createSurface, {
        surfaceId: 'demo_builtin',
        catalogId: 'agentplace:builtin-v1',
      });
      surfaces.applySurfaceEvent(A2UI_EVENT_NAMES.updateComponents, {
        surfaceId: 'demo_builtin',
        components: [
          {
            id: 'root',
            component: 'Chart',
            chartType: 'bar',
            title: 'Preview chart',
            categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            series: [{ label: 'Visits', values: [12, 19, 9, 22, 16] }],
          },
        ],
      });
    };

    window.__a2uiDemo = pushBuiltinPreview;
    return () => {
      window.__a2uiDemo = undefined;
    };
  }, [messagesStore]);
}
