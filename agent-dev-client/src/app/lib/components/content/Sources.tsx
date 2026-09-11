import { useId, type FC } from 'react';
import { useIntl } from 'react-intl';
import type { AsArgumentsProps } from '@/app/lib/types';
import { messages } from '@/app/lib/localization/messages.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';

type SourceItem = {
  title?: string;
  url?: string;
};

function readSources(value: unknown): SourceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sources: SourceItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    const url = typeof item['url'] === 'string' ? item['url'].trim() : '';
    if (title || url) {
      sources.push({ title: title || undefined, url: url || undefined });
    }
  }
  return sources;
}

function linkUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

const Sources: FC<AsArgumentsProps<{ sources?: unknown }>> = ({ argumentsProps }) => {
  const intl = useIntl();
  const headingId = useId();
  const sources = readSources(argumentsProps.sources);
  if (sources.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} className="py-2">
      <h3 id={headingId} className="text-sm font-medium text-foreground">
        {intl.formatMessage(messages.sourcesLabel)}
      </h3>
      <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
        {sources.map((source, index) => {
          const label = source.title ?? source.url;
          const href = linkUrl(source.url);
          return (
            <li key={`${source.url ?? source.title}-${index}`} className="break-words">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {label}
                </a>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default Sources;
