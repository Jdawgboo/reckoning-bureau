/**
 * Omnibox input: pill container with an attach button on the left,
 * placeholder, mic toggle, and a send/stop glyph. ⌘K focuses the input
 * (keyboard-only — the visual hint gave its slot to the mic). Controlled
 * internally (local text/attachment state only) — the store owns send/abort
 * via props.
 *
 * Modality parity with `ConversationInput`: attachments via the shared
 * composer-attach helpers (pick, paste, drop; 5-file cap and per-file
 * errors), voice via the same speech-mode toggle + `AudioRecorderContext`.
 * In voice mode the pill swaps its content for the waveform + controls; the
 * actual audio send happens through `AudioSender` mounted by `StageShell`.
 */
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { observer } from 'mobx-react-lite';
import { cn } from '@/app/lib/utils';
import { Mic, MicOff, X } from 'lucide-react';
import { useGlobalAudioPlayer } from 'react-use-audio-player';
import { useIntl, type IntlShape } from 'react-intl';
import type { Attachment } from '@/app/lib/types/files';
import { useMessagingStore } from '@/app/lib/hooks/useMessagingStore';
import { useAudioRecorderContext } from '@/app/lib/contexts';
import { AttachmentChip } from '@/app/lib/components/input/AttachmentChip';
import { Button } from '@/app/lib/shadcdn/button';
import { AdaptiveWaveform } from '@/app/lib/components/AgentInput/AdaptiveWaveform';
import {
  type AttachError,
  COMPOSER_ACCEPT_ATTR,
  COMPOSER_MAX_FILES,
  filesToAttachments,
} from '@/app/lib/files/composer-attach';
import { messages } from '@/app/lib/localization/messages.ts';

export interface StageOmniboxProps {
  placeholder: string;
  pending: boolean;
  /** Voice-mode line (live caption or status word) rendered inside the
   *  waveform area — the dock's guidance slot is hidden during voice. */
  voiceLine?: string | null;
  /** True when the line is a status word — renders with the shimmer. */
  voiceLineStatus?: boolean;
  /** The in-flight request's text — ghosted inside the field until the
   *  answer lands. Typing starts a fresh message over it. */
  sentText: string | null;
  onSend: (text: string, files?: Attachment[]) => void;
  onStop: () => void;
}

function attachErrorText(err: AttachError, intl: IntlShape): string {
  if (err.code === 'too_large') {
    return intl.formatMessage(messages.attachmentTooLarge, { filename: err.filename });
  }
  if (err.code === 'unsupported') {
    return intl.formatMessage(messages.attachmentUnsupported, {
      filename: err.filename,
      extension: err.extension,
    });
  }
  return intl.formatMessage(messages.attachmentLimit, { count: err.allowed });
}

export const StageOmnibox: FC<StageOmniboxProps> = observer(
  ({ placeholder, pending, sentText, onSend, onStop, voiceLine, voiceLineStatus }) => {
    const [text, setText] = useState('');
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [errors, setErrors] = useState<AttachError[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Mirror for synchronous reads inside the async ingest path — overlapping
    // drops must not both observe the same pre-ingest count.
    const attachmentsRef = useRef<Attachment[]>([]);
    const intl = useIntl();

    const messagesStore = useMessagingStore();
    const {
      enableMicrophone,
      disableMicrophone,
      isRecording,
      isPending,
      startRecording,
      stopRecording,
    } = useAudioRecorderContext();
    const { playing: isAISpeaking, pause } = useGlobalAudioPlayer();

    useEffect(() => {
      const handleKeyDown = (event: globalThis.KeyboardEvent) => {
        const isFocusShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
        if (!isFocusShortcut) {
          return;
        }
        event.preventDefault();
        inputRef.current?.focus();
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const ingestFiles = useCallback(async (incoming: File[]) => {
      if (incoming.length === 0) {
        return;
      }
      setErrors([]);
      const { attachments: parsed, errors: errs } = await filesToAttachments(
        incoming,
        attachmentsRef.current,
      );
      if (parsed.length > 0) {
        setAttachments((prev) => {
          const next = [...prev, ...parsed].slice(0, COMPOSER_MAX_FILES);
          attachmentsRef.current = next;
          return next;
        });
      }
      if (errs.length > 0) {
        setErrors(errs);
      }
    }, []);

    const handlePickFiles = (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      void ingestFiles(files);
      event.target.value = '';
    };

    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData.items;
      if (!items || items.length === 0) {
        return;
      }
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        void ingestFiles(files);
      }
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      void ingestFiles(files);
    };

    const removeAttachment = (index: number) => {
      setAttachments((prev) => {
        const next = prev.filter((_, i) => i !== index);
        attachmentsRef.current = next;
        return next;
      });
      setErrors([]);
    };

    // Ghost echo: the sent text stays visible in the field while the agent
    // works; any typing (local text) replaces it instantly.
    const showGhost = Boolean(sentText) && text.length === 0;
    // The placeholder is an overlay span, not the native attribute:
    // `field-sizing: content` sizes an empty textarea to its placeholder, so a
    // placeholder longer than one line wraps and stretches the whole pill on
    // narrow viewports. The span truncates to one line instead.
    const showPlaceholder = !showGhost && text.length === 0;

    const canSend = text.trim().length > 0 || attachments.length > 0;

    const handleSend = () => {
      if (!canSend) {
        return;
      }
      onSend(text, attachments.length > 0 ? attachments : undefined);
      setText('');
      setAttachments([]);
      attachmentsRef.current = [];
      setErrors([]);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    };

    const handleVoiceToggle = () => {
      // Realtime engine owns its own mic (RealtimeVoiceSession); the v0
      // recorder pipeline only runs when the server does not advertise it.
      if (messagesStore.voiceEngine !== 'realtime') {
        if (messagesStore.speechEnabled) {
          disableMicrophone();
        } else {
          enableMicrophone();
        }
      }
      messagesStore.toggleSpeech();
    };

    // Stopping sends the clip through the recorder pipeline.
    const handleRecordToggle = () => {
      if (isRecording || isPending) {
        messagesStore.toggleRecordingAudio(false);
        stopRecording();
        return;
      }
      if (isAISpeaking) {
        pause();
      }
      messagesStore.toggleRecordingAudio(true);
      startRecording();
    };

    const handleVoiceExit = () => {
      if (isRecording || isPending) {
        messagesStore.toggleRecordingAudio(false);
        stopRecording();
      }
      handleVoiceToggle();
    };

    // Voice mode: ambient, one idiom for both engines — full-width waveform
    // with two outline icon controls docked bottom-right. The waveform carries
    // the channel state. Realtime: mute + end. v0: record-toggle + end
    // (press mic to record, press again to stop-and-send).
    if (messagesStore.speechEnabled) {
      const realtime = messagesStore.voiceEngine === 'realtime';
      const recordingHot = isRecording || isPending;
      return (
        <div className="w-full relative">
          <div className="w-full h-28 px-6 pointer-events-none">
            <AdaptiveWaveform
              isActive={messagesStore.isRecordingAudio || isAISpeaking}
              isListening={realtime ? messagesStore.isRecordingAudio : isRecording}
              isAISpeaking={isAISpeaking}
            />
          </div>
          {voiceLineStatus && (
            <div className="stage-progress-track pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" />
          )}
          {voiceLine && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-2 px-6 pr-32 sm:pr-36"
              aria-live="polite"
            >
              <span
                className={cn(
                  'line-clamp-2 text-sm font-medium text-muted-foreground',
                  voiceLineStatus && 'shimmer-text',
                )}
              >
                {voiceLine}
              </span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-end gap-2 px-2 sm:px-8">
            {realtime ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="pointer-events-auto h-10 w-10 rounded-full border-border bg-muted text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-[active=true]:text-warning"
                data-active={messagesStore.voiceMuted}
                onClick={() => messagesStore.setVoiceMuted(!messagesStore.voiceMuted)}
                aria-label={intl.formatMessage(
                  messagesStore.voiceMuted ? messages.unmuteMicrophone : messages.muteMicrophone,
                )}
              >
                {messagesStore.voiceMuted ? <MicOff size={18} /> : <Mic size={18} />}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="pointer-events-auto h-10 rounded-full border-border bg-muted px-4 text-sm font-semibold text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-[active=true]:border-primary data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:hover:bg-primary data-[active=true]:hover:text-primary-foreground"
                data-active={recordingHot}
                onClick={handleRecordToggle}
              >
                <Mic size={16} className="mr-1.5" />
                {intl.formatMessage(recordingHot ? messages.tapToSend : messages.tapToSpeak)}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="pointer-events-auto h-10 w-10 rounded-full border-border bg-muted text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
              onClick={realtime ? handleVoiceToggle : handleVoiceExit}
              aria-label={intl.formatMessage(messages.endVoice)}
            >
              <X size={18} />
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="group"
        data-dragover={isDragOver}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragOver(false);
        }}
        onDrop={handleDrop}
      >
        <input
          type="file"
          ref={fileInputRef}
          multiple
          accept={COMPOSER_ACCEPT_ATTR}
          onChange={handlePickFiles}
          className="hidden"
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-1.5 pb-2">
            {attachments.map((attachment, index) => {
              const key = `${attachment.name}-${index}-${attachment.updateTms}`;
              if (attachment.type.startsWith('image/')) {
                return (
                  <div key={key} className="relative">
                    <img
                      src={`data:${attachment.type};base64,${attachment.data}`}
                      alt={attachment.name}
                      title={attachment.name}
                      className="h-14 w-14 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      aria-label={intl.formatMessage(messages.removeAttachment, {
                        filename: attachment.name,
                      })}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-elevated hover:text-foreground"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              }
              return (
                <AttachmentChip
                  key={key}
                  name={attachment.name}
                  mediaType={attachment.type}
                  sizeBytes={Math.floor((attachment.data.length * 3) / 4)}
                  onRemove={() => removeAttachment(index)}
                />
              );
            })}
          </div>
        )}
        {errors.length > 0 && (
          <div className="px-2 pb-2 text-xs text-warning">
            {errors.map((err, index) => (
              <div key={`${err.code}-${index}`}>{attachErrorText(err, intl)}</div>
            ))}
          </div>
        )}
        <div
          className={cn(
            'relative flex items-end gap-2.5 overflow-hidden rounded-lg border border-border bg-card py-2 pr-2 pl-4.5 shadow-lift group-data-[dragover=true]:border-dashed group-data-[dragover=true]:border-primary',
            pending && 'stage-progress-track',
          )}
          data-pending={pending}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-ml-2.5 mb-0.5 h-8.5 w-8.5 flex-none rounded-md text-muted-foreground-subtle hover:bg-muted hover:text-foreground"
            onClick={() => fileInputRef.current?.click()}
            aria-label={intl.formatMessage(messages.attachFiles)}
          >
            <svg
              className="h-4.5 w-4.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </Button>
          <div className="relative flex min-h-9.5 min-w-0 flex-1 items-center">
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className="stage-noscroll field-sizing-content max-h-[8lh] min-w-0 flex-1 resize-none border-none bg-transparent py-1.75 text-base leading-6 text-foreground outline-none"
              aria-label={placeholder}
            />
            {showGhost && (
              <span
                className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-ellipsis whitespace-nowrap text-base text-muted-foreground-subtle"
                aria-hidden="true"
              >
                {sentText}
              </span>
            )}
            {showPlaceholder && (
              <span
                className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-ellipsis whitespace-nowrap text-base text-muted-foreground-subtle"
                aria-hidden="true"
              >
                {placeholder}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mb-0.5 h-8.5 w-8.5 flex-none rounded-md text-muted-foreground-subtle hover:bg-muted hover:text-foreground"
            onClick={handleVoiceToggle}
            aria-label={intl.formatMessage(messages.voiceMode)}
          >
            <svg
              className="h-4.5 w-4.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </Button>
          {pending ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9.5 w-9.5 flex-none rounded-md bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onStop}
              aria-label={intl.formatMessage(messages.stopGenerating)}
            >
              <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
              </svg>
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="h-9.5 w-9.5 flex-none rounded-md disabled:opacity-40"
              onClick={handleSend}
              disabled={!canSend}
              aria-label={intl.formatMessage(messages.send)}
            >
              <svg
                className="h-4.5 w-4.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            </Button>
          )}
        </div>
      </div>
    );
  },
);
