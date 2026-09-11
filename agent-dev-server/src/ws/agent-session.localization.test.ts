import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { LocalizationBundleIdentity } from '../../../shared/index.ts';
import { AgentSession } from './agent-session.ts';

function session(now: () => number = Date.now): AgentSession {
  return new AgentSession({
    sessionKey: 'session-localization',
    userId: 'user-1',
    configId: 'agent-1',
    ttlMs: 60_000,
    now,
  });
}

function identity(
  messageLocale: string,
  sessionLocaleRevision: number,
): LocalizationBundleIdentity {
  return {
    catalogRevision: 'a'.repeat(64),
    messageLocale,
    sessionLocaleRevision,
  };
}

describe('AgentSession localization state', () => {
  it('keeps durable desired locale separate from attachment activation', async () => {
    const agentSession = session();
    assert.deepStrictEqual(agentSession.presentationLocale, {
      messageLocale: 'en',
      formatLocale: 'en',
      source: 'default',
      revision: 0,
    });
    await agentSession.proposeLocale('fr', 'explicit');
    assert.strictEqual(agentSession.presentationLocale.messageLocale, 'fr');
    assert.strictEqual(agentSession.localizationActivation('browser-1'), null);
  });

  it('tracks delivered and acknowledged identities independently per browser', () => {
    const agentSession = session();
    const french = identity('fr', 1);
    const german = identity('de', 2);
    agentSession.openLocalizationAttachment('browser-1');
    agentSession.openLocalizationAttachment('browser-2');

    assert.strictEqual(agentSession.recordLocalizationDelivery('browser-1', french), true);
    assert.strictEqual(agentSession.recordLocalizationDelivery('browser-1', french), false);
    assert.strictEqual(agentSession.recordLocalizationDelivery('browser-2', german), true);
    assert.deepStrictEqual(agentSession.acknowledgeLocalization('browser-1', german), {
      accepted: false,
    });
    assert.strictEqual(agentSession.acknowledgeLocalization('browser-1', french).accepted, true);
    assert.strictEqual(agentSession.acknowledgeLocalization('browser-2', german).accepted, true);

    assert.deepStrictEqual(agentSession.localizationActivation('browser-1'), french);
    assert.deepStrictEqual(agentSession.localizationActivation('browser-2'), german);
    agentSession.closeLocalizationAttachment('browser-1');
    assert.strictEqual(agentSession.localizationActivation('browser-1'), null);
    assert.deepStrictEqual(agentSession.localizationActivation('browser-2'), german);
  });

  it('measures delivery-to-activation lag without making it durable', () => {
    let nowMs = 1_000;
    const agentSession = session(() => nowMs);
    const french = identity('fr', 1);
    agentSession.openLocalizationAttachment('browser-1');
    agentSession.recordLocalizationDelivery('browser-1', french);
    nowMs = 1_375;

    assert.deepStrictEqual(agentSession.acknowledgeLocalization('browser-1', french), {
      accepted: true,
      activationLagMs: 375,
    });
    agentSession.closeLocalizationAttachment('browser-1');
    assert.strictEqual(agentSession.localizationActivation('browser-1'), null);
  });

  it('reports stable UI as pending, fallback, and active without making it durable', () => {
    const agentSession = session();
    const french = identity('fr', 1);
    agentSession.openLocalizationAttachment('browser-1');
    assert.deepStrictEqual(agentSession.localizationStatus(french), {
      status: 'pending',
      attachmentCount: 1,
    });
    agentSession.recordLocalizationFallback('browser-1', french, 'generation-failed');
    assert.deepStrictEqual(agentSession.localizationStatus(french), {
      status: 'source-fallback',
      attachmentCount: 1,
      reason: 'generation-failed',
    });
    agentSession.recordLocalizationDelivery('browser-1', french);
    agentSession.acknowledgeLocalization('browser-1', french);
    assert.deepStrictEqual(agentSession.localizationStatus(french), {
      status: 'active',
      attachmentCount: 1,
    });
  });

  it('reports the originating browser instead of conflating attached browser states', () => {
    const agentSession = session();
    const french = identity('fr', 1);
    agentSession.openLocalizationAttachment('origin');
    agentSession.openLocalizationAttachment('other');
    agentSession.recordLocalizationDelivery('origin', french);
    agentSession.acknowledgeLocalization('origin', french);

    assert.deepStrictEqual(agentSession.localizationStatus(french), {
      status: 'pending',
      attachmentCount: 2,
    });
    assert.deepStrictEqual(agentSession.localizationStatus(french, 'origin'), {
      status: 'active',
      attachmentCount: 1,
    });
    assert.deepStrictEqual(agentSession.localizationStatus(french, 'other'), {
      status: 'pending',
      attachmentCount: 1,
    });
  });
});
