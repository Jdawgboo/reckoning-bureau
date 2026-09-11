import IntlMessageFormat from 'intl-messageformat';
import type {
  FallbackLocalization,
  FallbackMessageValue,
} from '../../vendor/agentplace-a2ui/contract-schema.ts';
import type { VoiceClientMessageCode } from '../../vendor/agentplace-voice/realtime-session-manager.ts';

export interface ServerMessageDescriptor {
  id: string;
  defaultMessage: string;
  description?: string;
}

/** Extraction marker for stable server-owned messages; the build config registers this name. */
export function serverMessage<T extends ServerMessageDescriptor>(descriptor: T): T {
  return descriptor;
}

export const serverMessages = {
  submit: serverMessage({ id: 'common.submit', defaultMessage: 'Submit' }),
  choices: serverMessage({ id: 'surface.choices', defaultMessage: 'Choices' }),
  options: serverMessage({ id: 'surface.options', defaultMessage: 'Options' }),
  menu: serverMessage({ id: 'surface.menu', defaultMessage: 'Menu' }),
  seriesLabel: serverMessage({
    id: 'surface.seriesLabel',
    defaultMessage: 'Series {number}',
  }),
  categoryLabel: serverMessage({ id: 'surface.categoryLabel', defaultMessage: 'Category' }),
  videoLabel: serverMessage({ id: 'surface.videoLabel', defaultMessage: 'Video' }),
  titledVideoLabel: serverMessage({
    id: 'surface.titledVideoLabel',
    defaultMessage: 'Video: {title}',
  }),
  unavailableSuffix: serverMessage({
    id: 'surface.unavailableSuffix',
    defaultMessage: '{label} (unavailable)',
  }),
  fileReady: serverMessage({
    id: 'surface.fileReady',
    defaultMessage: 'File ready for download: {filename}',
  }),
  genericFile: serverMessage({ id: 'surface.genericFile', defaultMessage: 'file' }),
  statusLine: serverMessage({
    id: 'surface.statusLine',
    defaultMessage: 'Status: {status}',
  }),
  statusValue: serverMessage({
    id: 'surface.statusValue',
    defaultMessage:
      '{status, select, draft {Draft} committing {Committing} confirmed {Confirmed} failed {Failed} other {{status}}}',
  }),
  channelWorking: serverMessage({ id: 'channel.working', defaultMessage: '⏳ Working…' }),
  channelEmptyOutput: serverMessage({ id: 'channel.emptyOutput', defaultMessage: '(no output)' }),
  voiceNotEnabled: serverMessage({
    id: 'voice.notEnabled',
    defaultMessage: 'Live voice is not enabled for this agent.',
  }),
  voiceNotConfigured: serverMessage({
    id: 'voice.notConfigured',
    defaultMessage: 'Live voice is not configured for this agent yet.',
  }),
  voiceUnavailable: serverMessage({
    id: 'voice.unavailable',
    defaultMessage: 'Live voice is not available for this agent right now.',
  }),
  voiceMinutesExhausted: serverMessage({
    id: 'voice.minutesExhausted',
    defaultMessage: 'This agent has used up its voice minutes for the month.',
  }),
  voiceHistoryWriteFailed: serverMessage({
    id: 'voice.historyWriteFailed',
    defaultMessage: 'Voice history could not be saved; conversation continuity is degraded.',
  }),
  voiceTextInputInvalid: serverMessage({
    id: 'voice.textInputInvalid',
    defaultMessage: 'Voice text input is invalid.',
  }),
  voiceTextInputBusy: serverMessage({
    id: 'voice.textInputBusy',
    defaultMessage: 'Voice text input is busy.',
  }),
  voiceBackendError: serverMessage({
    id: 'voice.backendError',
    defaultMessage: 'Voice backend error.',
  }),
  voicePlaybackReconciliationFailed: serverMessage({
    id: 'voice.playbackReconciliationFailed',
    defaultMessage: 'Voice playback could not be reconciled; reconnect voice before continuing.',
  }),
  voiceWebSearchProgress: serverMessage({
    id: 'voice.webSearchProgress',
    defaultMessage:
      '{count, plural, one {Checking the web for supporting data.} other {Ran # web checks so far.}}',
  }),
  retryExhausted: serverMessage({
    id: 'error.retryExhausted',
    defaultMessage:
      'The model provider is temporarily unavailable. Please try again in a few minutes or select a different model.',
  }),
  creditsExhausted: serverMessage({
    id: 'error.creditsExhausted',
    defaultMessage:
      'This agent has run out of credits. Please contact the agent owner to restore service.',
  }),
  providerUnavailable: serverMessage({
    id: 'error.providerUnavailable',
    defaultMessage:
      'The selected model is temporarily unavailable. Please try again in a few minutes or select a different model.',
  }),
  modelOverloaded: serverMessage({
    id: 'error.modelOverloaded',
    defaultMessage:
      'The selected model is overloaded. Please try again in a few minutes or select a different model.',
  }),
  requestFailed: serverMessage({
    id: 'error.requestFailed',
    defaultMessage: 'Sorry, an error occurred while processing your request. Please try again.',
  }),
  unexpected: serverMessage({
    id: 'error.unexpected',
    defaultMessage: 'An unexpected error occurred.',
  }),
  budgetExhausted: serverMessage({
    id: 'error.budgetExhausted',
    defaultMessage: 'I need more tokens to perform this task.',
  }),
};

const voiceClientMessages: Record<VoiceClientMessageCode, ServerMessageDescriptor> = {
  'history-write-failed': serverMessages.voiceHistoryWriteFailed,
  'text-input-invalid': serverMessages.voiceTextInputInvalid,
  'text-input-busy': serverMessages.voiceTextInputBusy,
  'backend-error': serverMessages.voiceBackendError,
  'playback-reconciliation-failed': serverMessages.voicePlaybackReconciliationFailed,
};

export function voiceClientMessage(code: VoiceClientMessageCode): ServerMessageDescriptor {
  return voiceClientMessages[code];
}

export function formatServerMessage(
  localization: FallbackLocalization | undefined,
  descriptor: ServerMessageDescriptor,
  values?: Record<string, FallbackMessageValue>,
): string {
  if (localization) {
    return localization.format(descriptor.id, values);
  }
  const formatted = new IntlMessageFormat(descriptor.defaultMessage, 'en').format<string>(values);
  if (typeof formatted === 'string') {
    return formatted;
  }
  if (Array.isArray(formatted) && formatted.every((part) => typeof part === 'string')) {
    return formatted.join('');
  }
  throw new Error(`Stable server message "${descriptor.id}" produced non-text output.`);
}

export function formatAgentUserMessage(
  localization: FallbackLocalization | undefined,
  code: string,
): string {
  if (code === 'user_credits_exhausted' || code === 'user_quota_exhausted') {
    return formatServerMessage(localization, serverMessages.creditsExhausted);
  }
  if (code === 'platform_provider_unavailable') {
    return formatServerMessage(localization, serverMessages.providerUnavailable);
  }
  if (code === 'model_overloaded') {
    return formatServerMessage(localization, serverMessages.modelOverloaded);
  }
  if (code === 'retry_exhausted') {
    return formatServerMessage(localization, serverMessages.retryExhausted);
  }
  if (code === 'budget_exhausted') {
    return formatServerMessage(localization, serverMessages.budgetExhausted);
  }
  return formatServerMessage(localization, serverMessages.requestFailed);
}
