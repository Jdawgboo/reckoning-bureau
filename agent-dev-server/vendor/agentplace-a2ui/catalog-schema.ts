/**
 * v1 trusted catalog. The catalog is versioned; growth is additive; a
 * surface's catalogId pins compatibility. Unknown component types render an
 * inert fallback — never execute.
 */

export const V1_CATALOG_COMPONENTS: ReadonlySet<string> = new Set([
  'Text',
  'Row',
  'Column',
  'Card',
  'Button',
  'TextField',
  'ChoicePicker',
  'Image',
  'Divider',
  'List',
]);

export const V1_CATALOG_FUNCTIONS: ReadonlySet<string> = new Set([
  'required',
  'regex',
  'email',
  'formatString',
]);

export function isCatalogComponent(name: string): boolean {
  return V1_CATALOG_COMPONENTS.has(name);
}
