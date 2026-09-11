import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MENU_BOARD } from './menu-board.ts';

/**
 * The claim this example exists to prove: an authored contract can render
 * progressively, and never shows an item that is still being written.
 */
const partial = (props: Record<string, unknown>) => MENU_BOARD.composePartial?.(props).nodes ?? [];
const ids = (nodes: Array<{ id: string }>) => nodes.map((node) => node.id);

describe('MenuBoard progressive composition', () => {
  it('shows nothing when neither a title nor a finished item exists yet', () => {
    assert.deepStrictEqual(partial({ items: [{ name: 'Espresso', price: '€2' }] }), []);
  });

  it('withholds a title that is the last key seen — it may still be growing', () => {
    assert.deepStrictEqual(partial({ surfaceId: 'menu', title: 'Brea' }), []);
  });

  it('never renders a half-written title even when finished items follow it', () => {
    const nodes = partial({
      items: [{ name: 'Espresso', price: '€2.50' }, { name: 'Croiss' }],
      title: 'Brea',
    });
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-item-0']);
    assert.ok(!JSON.stringify(nodes).includes('Brea'), 'a growing title must never reach the tree');
  });

  it('streams items even when the title has not arrived — key order must not disable it', () => {
    const nodes = partial({
      items: [{ name: 'Espresso', price: '€2.50' }, { name: 'Croiss' }],
    });
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-item-0']);
  });

  it('shows the header before any item is finished', () => {
    const nodes = partial({ title: 'Breakfast', items: [{ name: 'Espresso' }] });
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-header']);
  });

  it('withholds the only item seen — a partial parse cannot prove it stopped growing', () => {
    const nodes = partial({ title: 'Breakfast', items: [{ name: 'Espresso', price: '€2' }] });
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-header']);
  });

  it('releases an item once a later one has started', () => {
    const nodes = partial({
      title: 'Breakfast',
      items: [{ name: 'Espresso', price: '€2' }, { name: 'Crois' }],
    });
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-header', 'menu-item-0']);
  });

  it('never emits a half-written price', () => {
    const nodes = partial({
      title: 'Breakfast',
      items: [
        { name: 'Espresso', price: '€2.50' },
        { name: 'Croissant', price: '€' },
      ],
    });
    const prices = nodes.map((node) => (node as { price?: string }).price).filter(Boolean);
    assert.deepStrictEqual(prices, ['€2.50']);
  });

  it('grows monotonically as the payload arrives', () => {
    const items = [
      { name: 'Espresso', price: '€2.50' },
      { name: 'Croissant', price: '€3.20' },
      { name: 'Porridge', price: '€5.00' },
    ];
    const counts = [1, 2, 3].map(
      (n) => partial({ title: 'Breakfast', items: items.slice(0, n) }).length,
    );
    assert.deepStrictEqual(counts, [2, 3, 4]);
  });

  it('the final compose includes every item, including the last', () => {
    const nodes =
      MENU_BOARD.compose?.({
        title: 'Breakfast',
        items: [
          { name: 'Espresso', price: '€2.50' },
          { name: 'Croissant', price: '€3.20' },
        ],
      }) ?? [];
    assert.deepStrictEqual(ids(nodes), ['root', 'menu-header', 'menu-item-0', 'menu-item-1']);
  });

  it('keeps node ids stable so a later emission updates rather than duplicates', () => {
    const streamed = partial({
      title: 'Breakfast',
      items: [{ name: 'Espresso', price: '€2.50' }, { name: 'Croissant' }],
    });
    const final =
      MENU_BOARD.compose?.({
        title: 'Breakfast',
        items: [
          { name: 'Espresso', price: '€2.50' },
          { name: 'Croissant', price: '€3.20' },
        ],
      }) ?? [];
    assert.ok(ids(streamed).every((id) => ids(final).includes(id)));
  });

  it('projects to markdown for channels with no live viewer', () => {
    const markdown = MENU_BOARD.fallbackTemplate?.({
      title: 'Breakfast',
      items: [{ name: 'Espresso', price: '€2.50', note: 'double shot' }],
    });
    assert.strictEqual(markdown, '## Breakfast\n\n- Espresso — €2.50 (double shot)');
  });
});
