import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { FallbackLocalization } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import {
  formatAgentUserMessage,
  formatServerMessage,
  serverMessages,
  voiceClientMessage,
} from './server-localization-messages.ts';

const german: FallbackLocalization = {
  format(messageId, values) {
    if (messageId === 'surface.seriesLabel') {
      return `Reihe ${String(values?.number)}`;
    }
    if (messageId === 'error.retryExhausted') {
      return 'Der Modelldienst ist vorübergehend nicht verfügbar.';
    }
    return messageId;
  },
};

describe('stable server localization messages', () => {
  it('formats ICU values through the committed host bundle', () => {
    assert.strictEqual(
      formatServerMessage(german, serverMessages.seriesLabel, { number: 4 }),
      'Reihe 4',
    );
  });

  it('maps SDK codes without provider text', () => {
    assert.strictEqual(
      formatAgentUserMessage(german, 'retry_exhausted'),
      'Der Modelldienst ist vorübergehend nicht verfügbar.',
    );
  });

  it('uses the extracted English descriptor when no session formatter exists', () => {
    assert.strictEqual(
      formatServerMessage(undefined, serverMessages.seriesLabel, { number: 3 }),
      'Series 3',
    );
  });

  it('maps provider-neutral voice codes to host-owned stable descriptors', () => {
    assert.strictEqual(voiceClientMessage('backend-error').id, 'voice.backendError');
    assert.strictEqual(
      voiceClientMessage('playback-reconciliation-failed').id,
      'voice.playbackReconciliationFailed',
    );
  });
});
