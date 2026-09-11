import type { FC } from 'react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { cn } from '@/app/lib/utils';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type Props = {
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  onRemove?: () => void;
  className?: string;
};

function humanSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AttachmentChip: FC<Props> = ({ name, mediaType, sizeBytes, onRemove, className }) => {
  const intl = useIntl();
  const isImage = mediaType?.startsWith('image/') ?? false;
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'bg-muted text-xs text-foreground border border-border',
        'max-w-xs',
        className,
      )}
    >
      {isImage ? (
        <ImageIcon size={12} className="text-muted-foreground shrink-0" />
      ) : (
        <FileText size={12} className="text-muted-foreground shrink-0" />
      )}
      <span className="truncate min-w-0">{name}</span>
      {sizeBytes != null && sizeBytes > 0 && (
        <span className="text-[10px] text-muted-foreground shrink-0">{humanSize(sizeBytes)}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label={intl.formatMessage(messages.removeAttachment, { filename: name })}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};
