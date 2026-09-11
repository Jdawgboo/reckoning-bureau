import type { ModelMessage } from '@ai-sdk/provider-utils';

type PartLike = {
  type?: unknown;
  toolCallId?: unknown;
  text?: unknown;
  data?: unknown;
  image?: unknown;
};

function payloadSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof URL) return value.href.length;
  return 0;
}

/**
 * Role + ordered tool ids, text, and file/image sizes. Excludes parts a
 * processor may strip (reasoning), so a rebuilt copy keeps its original's key.
 */
function messageIdentityKey(msg: ModelMessage): string {
  const role = typeof msg.role === 'string' ? msg.role : '?';
  const content: unknown = msg.content;
  if (!Array.isArray(content)) {
    return JSON.stringify([role, typeof content === 'string' ? content : '']);
  }
  const parts: unknown[] = [];
  for (const part of content as PartLike[]) {
    if (part.type === 'tool-call') {
      parts.push(['c', String(part.toolCallId ?? '')]);
    } else if (part.type === 'tool-result') {
      parts.push(['r', String(part.toolCallId ?? '')]);
    } else if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(['t', part.text]);
    } else if (part.type === 'file') {
      parts.push(['f', payloadSize(part.data)]);
    } else if (part.type === 'image') {
      parts.push(['i', payloadSize(part.image)]);
    }
  }
  return JSON.stringify([role, parts]);
}

/**
 * Messages of `current` that were not loaded — the turn's genuinely injected
 * messages. A multiset of identity keys makes processor-rebuilt copies match
 * their originals (ref diffing re-persisted them as orphaned duplicates) while
 * a new message repeating a loaded one's content still counts as injected.
 */
export function diffInjectedMessages(
  loaded: readonly ModelMessage[],
  current: readonly ModelMessage[],
): ModelMessage[] {
  const loadedRefs = new Set<ModelMessage>(loaded);
  const keyBudget = new Map<string, number>();
  for (const msg of loaded) {
    const key = messageIdentityKey(msg);
    keyBudget.set(key, (keyBudget.get(key) ?? 0) + 1);
  }

  const injected: ModelMessage[] = [];
  for (const msg of current) {
    const key = messageIdentityKey(msg);
    const remaining = keyBudget.get(key) ?? 0;
    if (loadedRefs.has(msg)) {
      if (remaining > 0) {
        keyBudget.set(key, remaining - 1);
      }
      continue;
    }
    if (remaining > 0) {
      keyBudget.set(key, remaining - 1);
      continue;
    }
    injected.push(msg);
  }
  return injected;
}
