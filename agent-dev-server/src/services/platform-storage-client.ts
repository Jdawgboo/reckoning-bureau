/**
 * Thin HTTP client for the platform-server's `/storage/presigned-url` endpoint.
 * Project layer (not agent-library) — platform-server specifics don't belong
 * in the generic SDK. Used by `storage-presigned-url.route.ts`.
 */

// Field-presence discriminator (`'reason' in result`) rather than a boolean —
// strictNullChecks is off in this package, so boolean narrowing breaks.
export type PresignedDownloadResult =
  | { url: string; expiresAt: number }
  | { reason: 'not-found' | 'compressed' };

export type FetchPresignedUrlParams = {
  /** Platform-server base URL, e.g. `https://api.agentplace.io`. */
  apiBaseUrl: string;
  /** Value to send as the `x-access-key` header. */
  accessKey: string;
  /** Storage path of the file, e.g. `report.pdf` or `dir/sub/file.csv`. */
  filePath: string;
  /** Session secretFolder when scoped to a private session; omitted for common storage. */
  location?: string;
  /** Whether the resulting URL should trigger download (`attachment`) or render inline (`inline`). */
  disposition: 'attachment' | 'inline';
  /** Hard timeout for the HTTP call to platform-server. Defaults to 10s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Calls platform-server `/storage/presigned-url`. Returns `{ url, expiresAt }`
 * on success, `{ reason: 'not-found' }` on 404, `{ reason: 'compressed' }` on
 * 409 (zstd-stored — direct S3 GET impossible). Throws on transport / other
 * non-2xx; callers surface as generic 5xx to the browser.
 */
export async function fetchPresignedDownloadUrl(
  params: FetchPresignedUrlParams,
): Promise<PresignedDownloadResult> {
  const qs = new URLSearchParams({
    path: params.filePath,
    disposition: params.disposition,
  });
  if (params.location) {
    qs.set('location', params.location);
  }

  const baseUrl = params.apiBaseUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/storage/presigned-url?${qs}`, {
    method: 'GET',
    headers: { 'x-access-key': params.accessKey },
    // Bound: wedged platform-server must not pin the client spinner.
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (response.status === 404) {
    return { reason: 'not-found' };
  }
  if (response.status === 409) {
    return { reason: 'compressed' };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`presigned-url request failed: HTTP ${response.status} ${detail}`.trim());
  }
  const body = (await response.json()) as
    | { success: true; url: string; expiresAt: number }
    | { success?: false; url?: undefined };
  if (!body.success || !body.url || typeof body.url !== 'string') {
    throw new Error('presigned-url response: malformed payload (missing url or success flag)');
  }
  return { url: body.url, expiresAt: body.expiresAt };
}
