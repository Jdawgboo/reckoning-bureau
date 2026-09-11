import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPresignedUrl } from '@/app/lib/services/presigned-url';
import { classifyImageRef } from '@/app/lib/agent-storage-ref';

/** Refresh window so the resolved `<img src>` loads before signature expiry. */
const REFRESH_LEAD_MS = 60_000;

type CachedUrl = { url: string; expiresAt: number };

// Module-level — shared across all Image instances in the tab so re-mounts
// (history scroll, streaming re-renders) reuse the URL until near expiry.
const urlCache = new Map<string, CachedUrl>();

function isFresh(entry: CachedUrl | undefined): entry is CachedUrl {
  return !!entry && Date.now() < entry.expiresAt - REFRESH_LEAD_MS;
}

/**
 * Resolves an `Image` src to a renderable URL: real URL schemes pass through; an
 * `agent-storage:` ref or bare name resolves to a presigned S3 URL (refetched once on error).
 */
export function useResolvedImageSrc(src: string): {
  resolvedSrc: string | null;
  error: string | null;
  handleImgError: () => void;
} {
  const classified = classifyImageRef(src);
  const storagePath = classified.kind === 'storage' ? classified.path : null;
  const isStorageRef = storagePath !== null;

  // Seed state from cache when we already have a fresh URL for this path.
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => {
    if (!isStorageRef) return src;
    const cached = urlCache.get(storagePath);
    return isFresh(cached) ? cached.url : null;
  });
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const retryControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Reset retry budget so a new path gets its own retry attempt.
    retryCountRef.current = 0;

    if (!isStorageRef || !storagePath) {
      setResolvedSrc(src);
      return;
    }
    const cached = urlCache.get(storagePath);
    if (isFresh(cached)) {
      setResolvedSrc(cached.url);
      return;
    }
    const controller = new AbortController();
    fetchPresignedUrl(storagePath, 'inline', controller.signal)
      .then((entry) => {
        if (controller.signal.aborted) return;
        urlCache.set(storagePath, entry);
        setResolvedSrc(entry.url);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'failed to resolve');
      });
    return () => {
      controller.abort();
      // Cancel any pending `<img onError>` retry too — otherwise it could
      // setState on an unmounted component after the parent moves on.
      retryControllerRef.current?.abort();
      retryControllerRef.current = null;
    };
  }, [isStorageRef, storagePath, src]);

  // Refetch ONCE on `<img>` error (URL likely expired). Capping at 1 prevents
  // a loop when the failure is structural (CORS, 403 from bucket policy, etc.).
  const handleImgError = useCallback(() => {
    if (!isStorageRef || !storagePath) return;
    if (retryCountRef.current >= 1) return;
    retryCountRef.current += 1;
    urlCache.delete(storagePath);
    const controller = new AbortController();
    retryControllerRef.current = controller;
    fetchPresignedUrl(storagePath, 'inline', controller.signal)
      .then((entry) => {
        if (controller.signal.aborted) return;
        urlCache.set(storagePath, entry);
        setResolvedSrc(entry.url);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'failed to reload');
      });
  }, [isStorageRef, storagePath]);

  return { resolvedSrc, error, handleImgError };
}
