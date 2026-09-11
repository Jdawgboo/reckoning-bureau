/**
 * Runs the realtime voice engine while omnibox voice mode is on and the
 * server advertises `voiceEngine: 'realtime'`. Renders nothing — audio and
 * the /voice WS live in the service; captions and the waveform flag flow
 * through the store.
 */
import { type FC, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { useMessagingStore } from '@/app/lib/hooks';
import {
  createVoiceRealtimeSession,
  type VoiceRealtimeSession as VoiceRealtimeSessionHandle,
} from '@/app/lib/services/voice-realtime.service';
import type { BrowserVoiceScreenSelection } from '../../../../../../shared/ws-protocol.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

const MAX_CAPTION_CHARS = 200;

interface RealtimeVoiceSessionProps {
  screenSelection: BrowserVoiceScreenSelection;
}

const RealtimeVoiceSessionComponent: FC<RealtimeVoiceSessionProps> = ({ screenSelection }) => {
  const messagesStore = useMessagingStore();
  const intl = useIntl();
  const intlRef = useRef(intl);
  intlRef.current = intl;
  const active = messagesStore.speechEnabled && messagesStore.voiceEngine === 'realtime';
  const sessionRef = useRef<VoiceRealtimeSessionHandle | null>(null);
  const captionRef = useRef('');
  const captionStaleRef = useRef(false);
  const screenSelectionRef = useRef(screenSelection);
  screenSelectionRef.current = screenSelection;

  useEffect(() => {
    if (!active) {
      return;
    }
    const session = createVoiceRealtimeSession({
      screenSelection: screenSelectionRef.current,
      memories: messagesStore.memoryStore.getAll(),
      onAssistantCaption: (delta) => {
        // The finished caption stays readable until the NEXT reply begins
        // (builder pattern) — the stale flag resets the buffer lazily.
        if (captionStaleRef.current) {
          captionRef.current = '';
          captionStaleRef.current = false;
        }
        captionRef.current = (captionRef.current + delta).slice(-MAX_CAPTION_CHARS);
        messagesStore.setVoiceCaption(captionRef.current);
      },
      onState: (state) => {
        if (state === 'listening') {
          captionStaleRef.current = true;
        }
        messagesStore.setVoiceState(state);
      },
      onRunBusy: (busy) => {
        // A finished run supersedes what was said when it started: without
        // this, the pre-run admission line ("Okay, I'll show…") resurfaces in
        // the status slot between the run ending and the result being spoken.
        if (!busy) {
          captionRef.current = '';
          captionStaleRef.current = false;
          messagesStore.setVoiceCaption('');
        }
        messagesStore.setVoiceRunBusy(busy);
      },
      onMemory: (summary) => {
        messagesStore.memoryStore.add(summary);
      },
      onError: (message) => {
        console.error('[RealtimeVoiceSession]', message);
        const reason = message || intlRef.current.formatMessage(messages.voiceUnknownError);
        messagesStore.notificationsStore.addNotification({
          message: intlRef.current.formatMessage(messages.voiceConnectionProblem, { reason }),
          type: 'error',
        });
      },
      onClose: () => {
        if (sessionRef.current === session && messagesStore.speechEnabled) {
          messagesStore.toggleSpeech();
        }
      },
    });
    sessionRef.current = session;
    messagesStore.toggleRecordingAudio(true);
    session.setMuted(messagesStore.voiceMuted);
    session.start().catch((error) => {
      console.error('[RealtimeVoiceSession] failed to start:', error);
      messagesStore.notificationsStore.addNotification({
        message: intlRef.current.formatMessage(messages.voiceStartFailed),
        type: 'error',
      });
      if (sessionRef.current === session && messagesStore.speechEnabled) {
        messagesStore.toggleSpeech();
      }
    });

    return () => {
      sessionRef.current = null;
      messagesStore.toggleRecordingAudio(false);
      messagesStore.setVoiceCaption('');
      captionRef.current = '';
      void session.stop();
    };
  }, [active, messagesStore]);

  const muted = messagesStore.voiceMuted;
  useEffect(() => {
    sessionRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    sessionRef.current?.updateScreen(screenSelection);
  }, [screenSelection]);

  return null;
};

export const RealtimeVoiceSession = observer(RealtimeVoiceSessionComponent);
