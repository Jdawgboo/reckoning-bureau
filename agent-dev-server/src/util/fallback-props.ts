import { isRecord } from './type-guards.ts';

/** Prop readers for fallback templates: tolerant of missing/malformed values. */
export function text(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return typeof value === 'string' ? value : '';
}

export function records(props: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = props[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
