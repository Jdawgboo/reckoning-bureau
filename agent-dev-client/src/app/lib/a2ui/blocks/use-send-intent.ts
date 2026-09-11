/**
 * Sends a tapped block action (an `intent` string) as a plain NEW user turn.
 * Deliberately bypasses the surface api.dispatch: an intent tap is a
 * visitor utterance, not a surface-scoped action — no surfaceId belongs on
 * it, and it behaves identically on live and history views.
 */
import { useMessagingStore } from '@/app/lib/hooks';

export function useSendIntent(): (intent: string) => void {
  const messagesStore = useMessagingStore();
  return (intent: string) => {
    if (!intent) {
      return;
    }
    void messagesStore.sendMessage({ instruction: intent });
  };
}
