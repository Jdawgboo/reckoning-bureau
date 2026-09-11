/**
 * Builtin component gallery (`?gallery=1`) — renders every builtin surface
 * with fixture data in one scrollable page, no agent required. Dev/design
 * review tool: interactions (dispatch/submit/setValue) land in the event log
 * at the bottom-right instead of starting agent turns; `setValue` writes are
 * kept in a local map so bound fields behave. Light/dark toggle drives the
 * same root class the shell uses, so the theme lever is reviewable too.
 */
import { useEffect, useMemo, useState, type FC } from 'react';
import type { ResolvedNode } from '../../../../../vendor/agentplace-a2ui/walker.ts';
import { A2uiSurfaceContext, type A2uiSurfaceApi } from '../surface-context.ts';
import { BUILTIN_SURFACE_COMPONENTS } from '../builtin-catalog/index.ts';
import { GALLERY_ENTRIES, type GalleryEntry } from './gallery-fixtures.ts';
import { Button } from '@/app/lib/shadcdn/button';
import '@/app/lib/stage/stage-effects.css';

function makeNode(entry: GalleryEntry, index: number): ResolvedNode {
  return {
    id: `gallery-${entry.component}-${index}`,
    component: entry.component,
    known: true,
    props: entry.props,
    children: [],
    danglingChildIds: [],
    bindings: {},
  };
}

interface GalleryEvent {
  at: string;
  text: string;
}

export const GalleryView: FC = () => {
  const [dark, setDark] = useState(false);
  const [events, setEvents] = useState<GalleryEvent[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);
  }, [dark]);

  const log = (text: string) => {
    const at = new Date().toLocaleTimeString();
    setEvents((prev) => [{ at, text }, ...prev].slice(0, 8));
  };

  // Stateful stub of the per-surface API: values round-trip so bound fields
  // type; actions log instead of starting turns.
  const api = useMemo<A2uiSurfaceApi>(
    () => ({
      getValue: (pointer) => values[pointer],
      setValue: (pointer, value) => {
        setValues((prev) => ({ ...prev, [pointer]: value }));
        log(`setValue ${pointer} = ${JSON.stringify(value)}`);
      },
      submit: (node) => log(`submit from ${node.component}`),
      dispatch: (name, context) => log(`dispatch ${name} ${JSON.stringify(context)}`),
      commitValue: () => {},
      errorsFor: () => [],
    }),
    [values],
  );

  return (
    <div className="stage h-dvh overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-container-content px-6 pb-32 pt-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Builtin component gallery</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every builtin surface with fixture data. Interactions land in the event log — nothing
              reaches an agent.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground shadow-none hover:bg-muted hover:text-foreground"
            onClick={() => setDark((prev) => !prev)}
          >
            {dark ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>

        <A2uiSurfaceContext.Provider value={api}>
          <div className="flex flex-col gap-10">
            {GALLERY_ENTRIES.map((entry, index) => {
              const Component = BUILTIN_SURFACE_COMPONENTS[entry.component];
              const node = makeNode(entry, index);
              return (
                <section key={node.id}>
                  <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground-subtle">
                    {entry.label}
                  </h2>
                  <div className="rounded-lg border border-border bg-card p-6 shadow-elevated">
                    {Component ? (
                      <Component node={node} renderChildren={() => null} />
                    ) : (
                      <div className="text-sm text-warning">
                        No client component registered for "{entry.component}"
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </A2uiSurfaceContext.Provider>
      </div>

      {events.length > 0 && (
        <div className="fixed bottom-4 right-4 z-10 w-96 rounded-lg border border-border bg-card p-3 shadow-lift">
          <div className="mb-1.5 text-xs font-semibold text-muted-foreground">Event log</div>
          <div className="flex flex-col gap-1">
            {events.map((event, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: transient log lines, newest-first
                key={index}
                className="truncate font-mono text-xs text-muted-foreground"
                title={event.text}
              >
                <span className="text-muted-foreground-subtle">{event.at}</span> {event.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
