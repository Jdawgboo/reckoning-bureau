import type {
  LocalizationBundle,
  LocalizationFallbackReason,
  LocalizationResolveRequest,
  LocalizationResolveResult,
} from '../../../shared/index.ts';
import { isRecord } from '../util/type-guards.ts';

const DEFAULT_TIMEOUT_MS = 35_000;

type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LocalizationResolver {
  resolve(
    request: LocalizationResolveRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LocalizationResolveResult>;
}

export class PlatformLocalizationClient implements LocalizationResolver {
  readonly #apiBaseUrl: string;
  readonly #accessKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchImplementation;

  constructor(params: {
    apiBaseUrl: string;
    accessKey: string;
    timeoutMs?: number;
    fetchImpl?: FetchImplementation;
  }) {
    this.#apiBaseUrl = params.apiBaseUrl.replace(/\/$/, '');
    this.#accessKey = params.accessKey;
    this.#timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = params.fetchImpl ?? fetch;
  }

  async resolve(
    request: LocalizationResolveRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalizationResolveResult> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.#fetch(`${this.#apiBaseUrl}/localization/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-key': this.#accessKey,
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Localization resolve failed with HTTP ${response.status}.`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('Localization resolve returned invalid JSON.');
    }
    return parseResolveResult(body, request);
  }
}

function parseResolveResult(
  value: unknown,
  request: LocalizationResolveRequest,
): LocalizationResolveResult {
  if (!isRecord(value) || typeof value['status'] !== 'string') {
    throw new Error('Localization resolve returned an invalid result.');
  }
  if (value['status'] === 'ready') {
    assertOnlyKeys(value, ['status', 'catalogRevision', 'policyVersion', 'bundle']);
    if (
      value['catalogRevision'] !== request.catalogRevision ||
      value['policyVersion'] !== request.policyVersion
    ) {
      throw new Error('Localization resolve returned a result for another build.');
    }
    const bundle = parseBundle(value['bundle'], request.messageLocale);
    return {
      status: 'ready',
      catalogRevision: request.catalogRevision,
      policyVersion: request.policyVersion,
      bundle,
    };
  }
  if (value['status'] === 'source-fallback') {
    assertOnlyKeys(value, [
      'status',
      'catalogRevision',
      'messageLocale',
      'policyVersion',
      'reason',
      'retryAfterMs',
    ]);
    if (
      value['catalogRevision'] !== request.catalogRevision ||
      value['messageLocale'] !== request.messageLocale ||
      value['policyVersion'] !== request.policyVersion ||
      !isFallbackReason(value['reason'])
    ) {
      throw new Error('Localization resolve returned a mismatched fallback.');
    }
    const retryAfterMs = parseRetryAfter(value['retryAfterMs']);
    return {
      status: 'source-fallback',
      catalogRevision: request.catalogRevision,
      messageLocale: request.messageLocale,
      policyVersion: request.policyVersion,
      reason: value['reason'],
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  throw new Error('Localization resolve returned an unknown status.');
}

function parseBundle(value: unknown, requestedLocale: string): LocalizationBundle {
  if (!isRecord(value)) {
    throw new Error('Localization resolve returned an invalid bundle.');
  }
  assertOnlyKeys(value, ['locale', 'messages']);
  if (value['locale'] !== requestedLocale || !isRecord(value['messages'])) {
    throw new Error('Localization resolve returned a bundle for another locale.');
  }
  const messages: Record<string, string> = {};
  for (const [id, message] of Object.entries(value['messages'])) {
    if (id.length === 0 || typeof message !== 'string' || message.length === 0) {
      throw new Error('Localization resolve returned invalid bundle messages.');
    }
    messages[id] = message;
  }
  return { locale: requestedLocale, messages };
}

function parseRetryAfter(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Localization resolve returned an invalid retry delay.');
  }
  return value;
}

function isFallbackReason(value: unknown): value is LocalizationFallbackReason {
  return (
    value === 'busy' ||
    value === 'rate-limited' ||
    value === 'generation-failed' ||
    value === 'storage-failed'
  );
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Localization resolve returned unexpected fields.');
  }
}
