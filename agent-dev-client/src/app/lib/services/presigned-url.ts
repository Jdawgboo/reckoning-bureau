import { AgentAuth } from '@/app/lib/agent-auth';

export type PresignedUrl = { url: string; expiresAt: number };

/**
 * Mints a short-lived S3 presigned URL via agent-dev-server. `disposition`
 * picks the Content-Disposition: `inline` to render, `attachment` to download.
 * Throws a human-readable Error on failure — including 409, which means the
 * file is zstd-compressed and can't be served by a direct S3 GET.
 */
export async function fetchPresignedUrl(
  path: string,
  disposition: 'inline' | 'attachment',
  signal?: AbortSignal,
): Promise<PresignedUrl> {
  const endpoint = `/api/storage/presigned-url?path=${encodeURIComponent(path)}&disposition=${disposition}`;
  const response = await AgentAuth.fetch(endpoint, { signal });
  if (!response.ok) {
    if (response.status === 409) {
      const verb = disposition === 'attachment' ? 'downloaded directly' : 'displayed inline';
      throw new Error(`This file is stored compressed and can't be ${verb}.`);
    }
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Non-JSON body; keep the generic status detail.
    }
    throw new Error(detail);
  }
  const body = (await response.json()) as { url: string; expiresAt: number };
  return { url: body.url, expiresAt: body.expiresAt };
}
