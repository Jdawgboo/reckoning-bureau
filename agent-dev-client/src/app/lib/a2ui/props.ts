/** Prop readers for surface adapters: tolerant narrowing from `node.props`. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
