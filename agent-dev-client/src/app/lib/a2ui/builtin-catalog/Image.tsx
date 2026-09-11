import type { FC } from 'react';
import { ImageWithScanEffectComponent } from '@/app/lib/components/ImageWithScanEffect';
import { useResolvedImageSrc } from '@/app/lib/hooks';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export type ImageProps = {
  src: string;
  alt?: string;
};

const ImageComponent: FC<{ argumentsProps: ImageProps }> = ({ argumentsProps }) => {
  const { src, alt } = argumentsProps;
  const intl = useIntl();
  const { resolvedSrc, error, handleImgError } = useResolvedImageSrc(src);

  if (!src) return null;
  if (error) {
    return (
      <div className="text-destructive text-sm">
        {intl.formatMessage(messages.imageError, { reason: error })}
      </div>
    );
  }
  if (resolvedSrc === null) {
    return (
      <div className="text-muted-foreground text-sm">
        {intl.formatMessage(messages.imageLoading)}
      </div>
    );
  }

  return (
    <div className="w-full bg-transparent text-center max-w-container-xl">
      <div className="relative w-full mx-auto">
        <ImageWithScanEffectComponent src={resolvedSrc} alt={alt} onError={handleImgError} />
      </div>
    </div>
  );
};

export default function Image(props: { argumentsProps: ImageProps }) {
  return <ImageComponent {...props} />;
}

export const ImageSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <Image argumentsProps={{ src: str(node.props.src), alt: optStr(node.props.alt) }} />
);
