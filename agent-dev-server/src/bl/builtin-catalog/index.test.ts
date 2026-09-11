import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BUILTIN_CATALOG_ID, BUILTIN_SURFACE_CONTRACTS } from './index.ts';
import { contractToFlatToolSchema } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { assertProviderSafeToolSchema } from '../tools/impl/schema-dialect-guards.ts';

describe('builtin surface contracts', () => {
  it('ships the twelve builtin components (display + choose/collect/commit + prose)', () => {
    assert.deepStrictEqual(Object.keys(BUILTIN_SURFACE_CONTRACTS).sort(), [
      'Chart',
      'ChoiceBoard',
      'FileDownload',
      'Form',
      'Image',
      'List',
      'OptionGrid',
      'Steps',
      'Summary',
      'Table',
      'TextBlock',
      'Video',
    ]);
    assert.ok(BUILTIN_CATALOG_ID.length > 0);
  });

  it('textblock fallback renders title, body, and blocks', () => {
    const fallback = BUILTIN_SURFACE_CONTRACTS.TextBlock.fallbackTemplate?.({
      title: 'About us',
      body: 'We fix things.',
      blocks: [
        { type: 'heading', text: 'Hours' },
        { type: 'text', text: 'Mon-Fri 9-17' },
        { type: 'image', imageUrl: 'https://example.com/a.jpg', imageAlt: 'Shop' },
        { type: 'button', label: 'Book now', intent: 'I want to book' },
      ],
    });
    assert.ok(fallback?.includes('## About us'));
    assert.ok(fallback?.includes('We fix things.'));
    assert.ok(fallback?.includes('### Hours'));
    assert.ok(fallback?.includes('![Shop](https://example.com/a.jpg)'));
    assert.ok(fallback?.includes('→ Book now'));
  });

  it('every contract is provider-safe, derives a fallback, and targets the stage', () => {
    for (const [name, contract] of Object.entries(BUILTIN_SURFACE_CONTRACTS)) {
      assert.ok(contract.purpose.length > 0, `${name} purpose`);
      assert.ok(contract.fallbackTemplate, `${name} fallbackTemplate`);
      assertProviderSafeToolSchema(contractToFlatToolSchema(contract), `Render${name}`);
    }
  });

  it('table fallback ports the Tier-1 markdown projection', () => {
    const fallback = BUILTIN_SURFACE_CONTRACTS.Table.fallbackTemplate?.({
      title: 'Prices',
      columns: [
        { header: 'Service', accessor: 's' },
        { header: 'Price', accessor: 'p' },
      ],
      rows: [
        ['Tune-up', '$80'],
        ['Brake fix', '$45'],
      ],
      footer: [{ content: 'All prices incl. VAT', colSpan: 2 }],
    });
    assert.ok(fallback?.includes('### Prices'));
    assert.ok(fallback?.includes('| Service | Price |'));
    assert.ok(fallback?.includes('| Tune-up | $80 |'));
    assert.ok(fallback?.includes('All prices incl. VAT'));
  });

  it('rows schema is a Gemini-safe nested scalar array', () => {
    const schema = contractToFlatToolSchema(BUILTIN_SURFACE_CONTRACTS.Table);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const rowsItems = properties.rows.items as Record<string, unknown>;
    assert.strictEqual(rowsItems.type, 'array');
    assert.deepStrictEqual(rowsItems.items, { type: 'string', description: 'Cell value' });
  });
});

describe('chart contract', () => {
  it('derives a table-shaped fallback (charts are lossy in text)', () => {
    const fallback = BUILTIN_SURFACE_CONTRACTS.Chart.fallbackTemplate?.({
      title: 'Repairs per month',
      chartType: 'bar',
      categories: ['May', 'Jun'],
      series: [
        { label: 'Tune-ups', values: [12, 18] },
        { label: 'Brake fixes', values: [7, 9] },
      ],
    });
    assert.ok(fallback?.includes('### Repairs per month'));
    assert.ok(fallback?.includes('| Category | Tune-ups | Brake fixes |'));
    assert.ok(fallback?.includes('| May | 12 | 7 |'));
    assert.ok(fallback?.includes('| Jun | 18 | 9 |'));
  });

  it('series values schema is a Gemini-safe nested scalar array', () => {
    const schema = contractToFlatToolSchema(BUILTIN_SURFACE_CONTRACTS.Chart);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const seriesItems = properties.series.items as {
      properties: Record<string, Record<string, unknown>>;
    };
    const valuesItems = seriesItems.properties.values.items as Record<string, unknown>;
    assert.deepStrictEqual(valuesItems, { type: 'number', description: 'Value' });
  });
});
