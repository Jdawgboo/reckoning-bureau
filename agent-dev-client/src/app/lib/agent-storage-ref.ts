const STORAGE_REF_PREFIX = 'agent-storage:';

export type ResolvedRef = { kind: 'url'; url: string } | { kind: 'storage'; path: string };

function stripStorageRef(ref: string): string {
  return ref.startsWith(STORAGE_REF_PREFIX) ? ref.slice(STORAGE_REF_PREFIX.length) : ref;
}

function classify(ref: string, directScheme: RegExp): ResolvedRef {
  const stripped = stripStorageRef(ref);
  if (directScheme.test(stripped)) {
    return { kind: 'url', url: stripped };
  }
  return { kind: 'storage', path: stripped };
}

export function classifyImageRef(src: string): ResolvedRef {
  return classify(src, /^(https?|data|blob):/i);
}

export function classifyDownloadRef(path: string): ResolvedRef {
  return classify(path, /^https?:/i);
}
