import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionPresentationLocale } from '../../../../../shared/index.ts';
import { SetSessionLocaleSchema, SetSessionLocaleTool } from './set-session-locale.tool.ts';
import type { SessionLocaleRuntime } from '../../messaging/session-locale-runtime.ts';

class Runtime implements SessionLocaleRuntime {
  proposed: { locale: string; source: 'explicit' | 'conversation' } | null = null;
  status: ReturnType<SessionLocaleRuntime['stableUi']> = {
    status: 'pending',
    attachmentCount: 1,
  };

  async propose(
    locale: string,
    source: 'explicit' | 'conversation',
  ): Promise<SessionPresentationLocale> {
    this.proposed = { locale, source };
    return { messageLocale: locale, formatLocale: locale, source, revision: 2 };
  }

  current(): SessionPresentationLocale {
    return { messageLocale: 'en', formatLocale: 'en', source: 'default', revision: 0 };
  }

  stableUi(): ReturnType<SessionLocaleRuntime['stableUi']> {
    return this.status;
  }

  format(messageId: string): string {
    return messageId;
  }
}

describe('SetSessionLocaleTool', () => {
  it('treats an unambiguous one-word greeting as clear conversational evidence', () => {
    const tool = new SetSessionLocaleTool(new Runtime());

    assert.match(tool.getDescription(), /unambiguous one-word greeting counts/i);
    assert.doesNotMatch(tool.getDescription(), /substantive message/i);
  });

  it('accepts only locale intent and rejects visitor-supplied shared wording', () => {
    assert.strictEqual(
      SetSessionLocaleSchema.safeParse({ locale: 'fr-CA', evidence: 'explicit' }).success,
      true,
    );
    assert.strictEqual(
      SetSessionLocaleSchema.safeParse({ locale: 'fr-ca', evidence: 'explicit' }).success,
      false,
    );
    assert.strictEqual(
      SetSessionLocaleSchema.safeParse({ locale: 'fr', evidence: 'guess' }).success,
      false,
    );
    assert.strictEqual(
      SetSessionLocaleSchema.safeParse({
        locale: 'fr',
        evidence: 'explicit',
        translatedButton: 'Envoyer',
      }).success,
      false,
    );
  });

  it('commits through the shared runtime and reports pending UI truthfully', async () => {
    const runtime = new Runtime();
    const result = await new SetSessionLocaleTool(runtime).execute({
      locale: 'fr',
      evidence: 'explicit',
    });
    assert.deepStrictEqual(runtime.proposed, { locale: 'fr', source: 'explicit' });
    assert.match(String(result.output), /"status":"pending"/);
    assert.match(String(result.output), /do not claim/);
  });

  it('distinguishes acknowledged UI from source fallback', async () => {
    const runtime = new Runtime();
    runtime.status = { status: 'active', attachmentCount: 1 };
    const active = await new SetSessionLocaleTool(runtime).execute({
      locale: 'de',
      evidence: 'conversation',
    });
    assert.match(String(active.output), /acknowledged as active/);

    runtime.status = {
      status: 'source-fallback',
      attachmentCount: 1,
      reason: 'generation-failed',
    };
    const fallback = await new SetSessionLocaleTool(runtime).execute({
      locale: 'de',
      evidence: 'conversation',
    });
    assert.match(String(fallback.output), /remains in its prior complete language/);
  });
});
