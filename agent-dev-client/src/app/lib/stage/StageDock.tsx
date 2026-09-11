/**
 * Floating input dock over a ground-fade: the answer notice (when present),
 * the narrator line (agent's working status), and a lazy chips row above
 * the input. Renders `StageOmnibox` — the flagship input gets its own
 * dedicated control rather than composing the chat `ConversationInput`;
 * chat mode keeps that component untouched.
 */
import type { FC } from 'react';
import { cn } from '@/app/lib/utils';
import type { Attachment } from '@/app/lib/types/files';
import { StageOmnibox } from './StageOmnibox.tsx';
import { useKeyboardLift } from './use-keyboard-lift.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

export interface StageDockProps {
  /** Agent's working-status line, e.g. "Checking Thursday's calendar…". */
  /** Omnibox placeholder override; defaults to the template copy. */
  placeholder?: string;
  /** The in-flight request's text — ghosted inside the omnibox. */
  requestEcho: string | null;
  narration: string;
  /** 'status' = working phrase (shimmers); 'caption' = the voice's live
   *  words (plain — it is content, not a loading state). */
  narrationVariant: 'status' | 'caption';
  /** 'voice' shows the agent's voice/state; 'chips' shows next-step chips. */
  guideMode: 'voice' | 'chips';
  /** Live voice session: the guidance slot is hidden (its line renders
   *  inside the omnibox waveform area instead) to save vertical space. */
  voiceActive?: boolean;
  /** Lazy next-step labels; renders nothing when empty. */
  chips: string[];
  onChipSelect: (chip: string) => void;
  isUserRequestPending: boolean;
  onSend: (text: string, files?: Attachment[]) => void;
  onStopStreaming?: () => void;
  /** Business name for the input placeholder ("Ask <brand> anything…"). */
}

export const StageDock: FC<StageDockProps> = ({
  placeholder,
  requestEcho,
  narration,
  narrationVariant,
  guideMode,
  voiceActive = false,
  chips,
  onChipSelect,
  isUserRequestPending,
  onSend,
  onStopStreaming,
}) => {
  const keyboardLift = useKeyboardLift();
  const intl = useIntl();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-10 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-10 md:px-7"
      style={keyboardLift}
    >
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background from-55% to-transparent" />
      <div className="pointer-events-auto mx-auto flex max-w-container-form flex-col">
        {/* Persistent agent-guidance slot: fixed height while visible.
            Working → the agent's voice (narration); idle → next-step chips.
            Hidden during a live voice session — the voice line renders
            inside the omnibox waveform area instead. */}
        {!voiceActive && (
          <div className="group relative mb-2 min-h-8.5" data-mode={guideMode}>
            <div
              className="absolute inset-0 flex items-center gap-2 px-2 text-sm text-muted-foreground transition-opacity duration-[220ms] ease-in-out group-data-[mode=chips]:opacity-0 group-data-[mode=chips]:pointer-events-none"
              aria-live="polite"
              aria-hidden={guideMode !== 'voice'}
            >
              {narration && (
                <span
                  className={cn('font-medium', narrationVariant === 'status' && 'shimmer-text')}
                >
                  {narration}
                </span>
              )}
            </div>
            {/* The strip is shorter than the chips: with `inset-0` it clips their
              rounded corners and hover lift/shadow. Negative offsets balanced
              by padding extend the paint area without moving the visual center. */}
            <div
              className="scrollbar-none absolute -inset-2 flex items-center gap-2 overflow-x-auto p-2 transition-opacity duration-[220ms] ease-in-out group-data-[mode=voice]:opacity-0 group-data-[mode=voice]:pointer-events-none"
              aria-hidden={guideMode === 'voice'}
            >
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="flex-none cursor-pointer rounded-full bg-muted px-4 py-2 text-sm font-semibold text-primary transition-[background-color,color,box-shadow,transform] duration-[180ms] ease hover:-translate-y-px hover:bg-primary hover:text-primary-foreground hover:shadow-chip focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:translate-y-0 active:scale-95 active:shadow-none"
                  onClick={() => onChipSelect(chip)}
                  tabIndex={guideMode === 'voice' ? -1 : 0}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        <StageOmnibox
          sentText={requestEcho}
          placeholder={placeholder ?? intl.formatMessage(messages.askAnything)}
          pending={isUserRequestPending}
          voiceLine={voiceActive ? narration : null}
          voiceLineStatus={narrationVariant === 'status'}
          onSend={onSend}
          onStop={() => onStopStreaming?.()}
        />
      </div>
    </div>
  );
};
