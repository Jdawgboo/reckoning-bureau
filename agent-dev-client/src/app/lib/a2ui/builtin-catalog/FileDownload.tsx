import { useRef, useState, type FC } from 'react';
import { Download, FileText, AlertCircle } from 'lucide-react';
import { fetchPresignedUrl } from '@/app/lib/services/presigned-url';
import { classifyDownloadRef } from '@/app/lib/agent-storage-ref';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export type FileDownloadProps = {
  filename?: string;
  path?: string;
};

/**
 * Chat card for a file produced by the code-executor subagent. Click mints
 * a short-lived S3 presigned URL via agent-dev-server and navigates a hidden
 * `<a download>` straight to S3 — bytes never pass through us.
 */
const FileDownloadComponent: FC<{ argumentsProps: FileDownloadProps }> = ({ argumentsProps }) => {
  const { filename, path } = argumentsProps;
  const intl = useIntl();
  const [state, setState] = useState<'idle' | 'downloading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // `disabled` only applies after the next render, so two synchronous clicks
  // can both enter handleClick before React catches up — guard with a ref.
  const inFlightRef = useRef(false);

  // Without `path` the card is unusable — no fetch target.
  if (!path) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-destructive">
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>{intl.formatMessage(messages.filePathMissing)}</span>
      </div>
    );
  }

  const handleClick = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState('downloading');
    setErrorMsg(null);
    try {
      const target = classifyDownloadRef(path);
      const targetValue = target.kind === 'url' ? target.url : target.path;
      const downloadUrl =
        target.kind === 'url'
          ? target.url
          : (await fetchPresignedUrl(target.path, 'attachment')).url;
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.rel = 'noopener';
      // Use the basename, not the storage path — browsers won't honour a
      // nested-path "download" name and it shows up oddly in the save dialog.
      a.download = filename ?? targetValue.split('/').pop() ?? path;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setState('idle');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      setErrorMsg(msg);
      setState('error');
    } finally {
      inFlightRef.current = false;
    }
  };

  const label = filename ?? path;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === 'downloading'}
      className="flex items-center gap-3 w-full max-w-md py-2 px-3 rounded-md border border-border bg-card hover:bg-accent/30 transition-colors text-left disabled:opacity-60 disabled:cursor-wait"
    >
      <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{label}</div>
        {state === 'error' && (
          <div className="text-xs text-destructive truncate">
            {intl.formatMessage(messages.downloadFailed, { reason: errorMsg })}
          </div>
        )}
      </div>
      <Download className="w-4 h-4 text-muted-foreground shrink-0" />
    </button>
  );
};

export default function FileDownload(props: { argumentsProps: FileDownloadProps }) {
  return <FileDownloadComponent {...props} />;
}

export const FileDownloadSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <FileDownload
    argumentsProps={{ filename: optStr(node.props.filename), path: optStr(node.props.path) }}
  />
);
