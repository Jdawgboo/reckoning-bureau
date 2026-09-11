/**
 * RFC 6901 JSON Pointer resolution against a plain data-model object.
 * v1 supports absolute pointers only (A2UI relative/collection scopes are a
 * later catalog version). Missing paths resolve to `undefined`, never throw.
 */

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') {
    return root ?? undefined;
  }
  const tokens = pointer
    .replace(/^\//, '')
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));

  let cursor: unknown = root;
  for (const token of tokens) {
    if (!isContainer(cursor)) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
    } else {
      if (!(token in cursor)) {
        return undefined;
      }
      cursor = cursor[token];
    }
  }
  return cursor;
}

/** Immutable set: returns a new root with `value` at `pointer`, creating
 *  missing object containers along the way (arrays are not auto-created). */
export function setAtPointer(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '' || pointer === '/') {
    return value;
  }
  const tokens = pointer
    .replace(/^\//, '')
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));

  function setIn(node: unknown, index: number): unknown {
    const token = tokens[index];
    const base =
      typeof node === 'object' && node !== null && !Array.isArray(node)
        ? { ...(node as Record<string, unknown>) }
        : {};
    if (index === tokens.length - 1) {
      base[token] = value;
      return base;
    }
    base[token] = setIn(base[token], index + 1);
    return base;
  }
  return setIn(root, 0);
}
