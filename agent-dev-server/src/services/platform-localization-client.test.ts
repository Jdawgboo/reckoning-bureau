import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { LocalizationResolveRequest } from '../../../shared/index.ts';
import { PlatformLocalizationClient } from './platform-localization-client.ts';

const request: LocalizationResolveRequest = {
  catalogRevision: 'a'.repeat(64),
  messageLocale: 'fr',
  policyVersion: 'localization-v4',
  catalogJson: '{}',
};

describe('PlatformLocalizationClient', () => {
  it('authenticates a bounded resolve request and validates ready responses', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const client = new PlatformLocalizationClient({
      apiBaseUrl: 'https://platform.example/',
      accessKey: 'runtime-key',
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({
          status: 'ready',
          catalogRevision: request.catalogRevision,
          policyVersion: request.policyVersion,
          bundle: { locale: 'fr', messages: { home: 'Accueil' } },
        });
      },
    });

    assert.deepStrictEqual(await client.resolve(request), {
      status: 'ready',
      catalogRevision: request.catalogRevision,
      policyVersion: request.policyVersion,
      bundle: { locale: 'fr', messages: { home: 'Accueil' } },
    });
    assert.strictEqual(capturedUrl, 'https://platform.example/localization/resolve');
    assert.strictEqual(capturedInit?.method, 'POST');
    assert.strictEqual(new Headers(capturedInit?.headers).get('x-access-key'), 'runtime-key');
    assert.ok(capturedInit?.signal instanceof AbortSignal);
    assert.deepStrictEqual(JSON.parse(String(capturedInit?.body)), request);
  });

  it('retains a strictly validated fallback disposition', async () => {
    const client = clientReturning({
      status: 'source-fallback',
      catalogRevision: request.catalogRevision,
      messageLocale: 'fr',
      policyVersion: request.policyVersion,
      reason: 'busy',
      retryAfterMs: 250,
    });
    assert.deepStrictEqual(await client.resolve(request), {
      status: 'source-fallback',
      catalogRevision: request.catalogRevision,
      messageLocale: 'fr',
      policyVersion: request.policyVersion,
      reason: 'busy',
      retryAfterMs: 250,
    });
  });

  it('rejects HTTP, malformed, mismatched, and over-specified responses', async () => {
    const failure = new PlatformLocalizationClient({
      apiBaseUrl: 'https://platform.example',
      accessKey: 'runtime-key',
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    await assert.rejects(() => failure.resolve(request), /HTTP 503/);
    await assert.rejects(
      () => clientReturning({ status: 'ready' }).resolve(request),
      /another build|invalid bundle/,
    );
    await assert.rejects(
      () =>
        clientReturning({
          status: 'ready',
          catalogRevision: request.catalogRevision,
          policyVersion: request.policyVersion,
          bundle: { locale: 'de', messages: { home: 'Start' } },
        }).resolve(request),
      /another locale/,
    );
    await assert.rejects(
      () =>
        clientReturning({
          status: 'ready',
          catalogRevision: request.catalogRevision,
          policyVersion: request.policyVersion,
          bundle: { locale: 'fr', messages: { home: 'Accueil' } },
          visitorText: 'never accepted',
        }).resolve(request),
      /unexpected fields/,
    );
    await assert.rejects(
      () =>
        clientReturning({
          status: 'source-fallback',
          catalogRevision: request.catalogRevision,
          messageLocale: request.messageLocale,
          policyVersion: request.policyVersion,
          reason: 'disabled',
        }).resolve(request),
      /mismatched fallback/,
    );
  });
});

function clientReturning(value: unknown): PlatformLocalizationClient {
  return new PlatformLocalizationClient({
    apiBaseUrl: 'https://platform.example',
    accessKey: 'runtime-key',
    fetchImpl: async () => Response.json(value),
  });
}
