import { useState, type FC } from 'react';
import { Globe, AlertCircle } from 'lucide-react';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type Source = {
  url: string;
  domain: string;
  title?: string;
};

export type DeepResearchArgumentsProps = {
  status?: 'running' | 'completed' | 'error';
  query?: string;
  searchCount?: number;
  searches?: string[];
  currentSearch?: string;
  sources?: Source[];
  resultText?: string;
  error?: string;
};

const FAVICON_SMALL = (domain: string) =>
  `https://s2.googleusercontent.com/s2/favicons?domain=${domain}&sz=32`;

const FAVICON_CARD = (domain: string) =>
  `https://s2.googleusercontent.com/s2/favicons?domain=${domain}&sz=64`;

const Favicon: FC<{ domain: string; size?: 'sm' | 'card' }> = ({ domain, size = 'sm' }) => {
  const [failed, setFailed] = useState(false);

  if (size === 'card') {
    if (failed) {
      return (
        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Globe className="w-4 h-4 text-muted-foreground" />
        </div>
      );
    }
    return (
      <img
        src={FAVICON_CARD(domain)}
        width={32}
        height={32}
        loading="lazy"
        className="w-8 h-8 rounded-lg shrink-0 object-cover"
        onError={() => setFailed(true)}
        alt=""
      />
    );
  }

  if (failed) {
    return <Globe className="w-5 h-5 text-muted-foreground shrink-0" />;
  }

  return (
    <img
      src={FAVICON_SMALL(domain)}
      width={20}
      height={20}
      loading="lazy"
      className="w-5 h-5 rounded-full border-2 border-background object-cover shrink-0"
      onError={() => setFailed(true)}
      alt=""
    />
  );
};

const OverlappingFavicons: FC<{ domains: string[] }> = ({ domains }) => {
  const shown = domains.slice(0, 3);
  return (
    <div className="flex items-center">
      {shown.map((domain, i) => (
        <div key={domain} className={i > 0 ? '-ml-1.5' : ''}>
          <Favicon domain={domain} />
        </div>
      ))}
    </div>
  );
};

const SourceCard: FC<{ source: Source }> = ({ source }) => {
  const urlPath = (() => {
    try {
      const parsed = new URL(source.url);
      const path = parsed.pathname + parsed.search;
      return path.length > 1 ? path : null;
    } catch {
      return null;
    }
  })();

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-2 p-3 rounded-lg hover:bg-muted/40 transition-colors group"
    >
      <div className="flex items-center gap-3">
        <Favicon domain={source.domain} size="card" />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {source.domain.charAt(0).toUpperCase() + source.domain.slice(1).split('.')[0]}
          </div>
          <div className="text-xs text-muted-foreground truncate">{source.domain}</div>
        </div>
      </div>
      {source.title && (
        <div className="text-sm text-foreground/80 group-hover:text-foreground transition-colors line-clamp-2">
          {source.title}
        </div>
      )}
      {!source.title && urlPath && (
        <div className="text-xs text-muted-foreground truncate">{urlPath}</div>
      )}
    </a>
  );
};

const SourcesHeader: FC<{
  sources: Source[];
  onClick?: () => void;
}> = ({ sources, onClick }) => {
  const uniqueDomains = [...new Set(sources.map((s) => s.domain))];
  const sourceCount = sources.length;

  const content = (
    <div className="flex items-center gap-2">
      {uniqueDomains.length > 0 && <OverlappingFavicons domains={uniqueDomains} />}
      <span className="text-sm text-muted-foreground">
        {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
      </span>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="hover:opacity-80 transition-opacity">
        {content}
      </button>
    );
  }

  return content;
};

const RunningState: FC<{ props: DeepResearchArgumentsProps }> = ({ props }) => {
  const { sources = [] } = props;

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="py-2">
      <SourcesHeader sources={sources} />
    </div>
  );
};

const CompletedState: FC<{ props: DeepResearchArgumentsProps }> = ({ props }) => {
  const [expanded, setExpanded] = useState(false);
  const { sources = [], searches = [] } = props;

  return (
    <div className="py-2">
      <SourcesHeader sources={sources} onClick={() => setExpanded(!expanded)} />

      {expanded && (
        <div className="mt-3 max-h-[400px] overflow-y-auto scrollbar scrollbar-none border border-border rounded-sm">
          {searches.length > 0 && (
            <div className="p-3 flex flex-wrap gap-2">
              {searches.map((query, i) => (
                <span
                  key={i}
                  className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md"
                >
                  {query}
                </span>
              ))}
            </div>
          )}
          {sources.length > 0 && (
            <div className="divide-y divide-border/50">
              {sources.map((source) => (
                <SourceCard key={source.url} source={source} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ErrorState: FC<{ error?: string }> = ({ error }) => {
  const intl = useIntl();
  return (
    <div className="flex items-center gap-2 py-2">
      <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
      <span className="text-sm text-destructive">
        {error || intl.formatMessage(messages.researchFailed)}
      </span>
    </div>
  );
};

const DeepResearchComponent: FC<{ argumentsProps: DeepResearchArgumentsProps }> = ({
  argumentsProps,
}) => {
  const { status } = argumentsProps;

  if (status === 'error') {
    return <ErrorState error={argumentsProps.error} />;
  }

  if (status === 'completed') {
    return <CompletedState props={argumentsProps} />;
  }

  return <RunningState props={argumentsProps} />;
};

export default DeepResearchComponent;
