import type React from 'react';
import { useEffect, useReducer, useState } from 'react';
import { cn } from '@/app/lib/utils';
import ReactPlayerImport from 'react-player';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { LoaderBlocker } from '@/app/lib/components/Loader';
import { TextGenerateEffect } from '@/app/lib/shadcdn/text-generate-effect';
import type { FC } from 'react';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export type VideoProps = {
  title?: string;
  src: string;
  poster?: string;
};

/** react-player ships CJS; esbuild's Node-style interop hands a DEFAULT
 *  import the module record ({ default: Player }) while Vite hands the class
 *  itself. Unwrap whichever arrived — narrow, single-purpose interop cast. */
type ReactPlayerClass = typeof ReactPlayerImport;
function resolvePlayer(candidate: unknown): ReactPlayerClass {
  if (isRecord(candidate) && typeof candidate['default'] === 'function') {
    return candidate['default'] as ReactPlayerClass;
  }
  return candidate as ReactPlayerClass;
}
const ReactPlayer = resolvePlayer(ReactPlayerImport);

type VideoPlayerStateT = {
  src: string;
  pip: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
};

type ActionT = {
  type: string;
  payload: any;
};

function reducer(state: VideoPlayerStateT, action: ActionT) {
  switch (action.type) {
    case 'SET_PLAYING':
      return { ...state, playing: action.payload };
    case 'SET_PIP':
      return { ...state, pip: action.payload };
    case 'SET_PLAYBACK_RATE':
      return { ...state, playbackRate: action.payload };
    default:
      throw new Error(`Unhandled action type: ${action.type}`);
  }
}

const VideoComponent: React.FC<{ argumentsProps: VideoProps }> = ({ argumentsProps }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const { title, src, poster } = argumentsProps;
  const intl = useIntl();

  const [state, dispatch] = useReducer(reducer, {
    src: src,
    pip: false,
    playing: false,
    volume: 0.8,
    muted: true,
    playbackRate: 1.0,
  });

  useEffect(() => {
    if (!src?.length) {
      setIsError(true);
    }
  }, [src]);

  const handleOnReady = (_player: InstanceType<ReactPlayerClass>): void => {
    setIsLoading(false);
  };

  const handlePlay = (): void => {
    dispatch({ type: 'SET_PLAYING', payload: true });
  };

  const handleEnablePIP = (): void => {
    dispatch({ type: 'SET_PIP', payload: true });
  };

  const handleDisablePIP = (): void => {
    dispatch({ type: 'SET_PIP', payload: false });
  };

  const handlePause = (): void => {
    dispatch({ type: 'SET_PLAYING', payload: false });
  };

  const handleOnError = (error: any, data?: any, hlsInstance?: any, hlsGlobal?: any): void => {
    setIsError(true);
  };

  const handleOnPlaybackRateChange = (speed: string) => {
    dispatch({ type: 'SET_PLAYBACK_RATE', payload: parseFloat(speed) });
  };

  const getPlaceholder = () => {
    if (isLoading && poster) {
      return (
        <img
          src={poster}
          alt={intl.formatMessage(messages.videoPlaceholder)}
          className="absolute inset-0 w-full h-full object-cover rounded-md z-10"
        />
      );
    } else if (isLoading) {
      return <LoaderBlocker />;
    }
  };

  return (
    <section
      className={cn(
        'w-full max-w-container-xl flex justify-center items-center rounded-lg bg-card overflow-hidden',
        'p-[20px] md:p-[50px_80px_90px]',
      )}
    >
      <main className="flex flex-col items-center w-full max-w-container-lg md:max-w-full">
        <header className="flex flex-col justify-start items-center w-full max-w-container-content">
          {title && (
            <TextGenerateEffect
              words={title}
              className="mb-3 w-full text-base font-semibold text-foreground"
              duration={0.25}
              filter={true}
            />
          )}
        </header>
        {isError && (
          <div className="h-full w-full flex justify-center items-center mx-20">
            <div>
              <p className="break-words break-all text-left text-base text-muted-foreground">
                {intl.formatMessage(messages.videoUnavailable)}{' '}
                <a
                  href={state.src}
                  className="text-link hover:text-link-hover underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {state.src}
                </a>
                . {intl.formatMessage(messages.possibleReasons)}
              </p>
              <ul className="list-disc list-inside mt-2 text-left text-base text-muted-foreground">
                <li>{intl.formatMessage(messages.videoUrlProblem)}</li>
                <li>{intl.formatMessage(messages.videoFormatProblem)}</li>
                <li>{intl.formatMessage(messages.videoPrivacyProblem)}</li>
              </ul>
            </div>
          </div>
        )}
        {!isError && (
          <div className="relative flex justify-center items-center w-full h-full backdrop-blur-[12px] rounded-lg">
            <div className="relative z-10 flex justify-center items-center w-full h-full overflow-hidden rounded-md">
              <div className="player-wrapper w-full aspect-video h-full relative">
                {getPlaceholder()}
                <div className={cn(isLoading && 'invisible', 'visible h-full w-full')}>
                  <ReactPlayer
                    width="100%"
                    height="100%"
                    url={state.src}
                    pip={state.pip}
                    playing={state.playing}
                    controls={true}
                    light={false}
                    loop={false}
                    playbackRate={state.playbackRate}
                    volume={state.volume}
                    muted={state.muted}
                    onReady={handleOnReady}
                    onPlay={handlePlay}
                    onEnablePIP={handleEnablePIP}
                    onDisablePIP={handleDisablePIP}
                    onPause={handlePause}
                    onPlaybackRateChange={handleOnPlaybackRateChange}
                    onError={handleOnError}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </section>
  );
};

export default function Video(props: { argumentsProps: VideoProps }) {
  return <VideoComponent {...props} />;
}

export const VideoSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <Video
    argumentsProps={{
      src: str(node.props.src),
      title: optStr(node.props.title),
      poster: optStr(node.props.poster),
    }}
  />
);
