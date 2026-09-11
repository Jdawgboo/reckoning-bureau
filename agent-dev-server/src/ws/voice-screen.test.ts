import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { A2uiComponentNode } from '../../vendor/agentplace-a2ui/types.ts';
import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import {
  buildVoiceScreen,
  createAttachmentVoiceScreenSource,
  type VoiceScreen,
} from './voice-screen.ts';

function structured(title: string): VoiceScreen {
  return {
    kind: 'structured',
    sections: [{ component: 'Card', props: { title } }],
    values: {},
    isSensitive: () => false,
  };
}

describe('createAttachmentVoiceScreenSource', () => {
  it('keeps selection local and resolves surface state fresh on every read', () => {
    let title = 'First value';
    const source = createAttachmentVoiceScreenSource({
      resolveSurface: (surfaceId) => (surfaceId === 'surface-1' ? structured(title) : null),
    });

    assert.deepStrictEqual(source.update({ kind: 'surface', surfaceId: 'surface-1' }), {
      status: 'updated',
    });
    const first = source.read();
    assert.strictEqual(first?.kind, 'structured');
    if (first?.kind === 'structured') {
      assert.deepStrictEqual(first.sections, structured('First value').sections);
    }
    title = 'Updated value';
    const updated = source.read();
    assert.strictEqual(updated?.kind, 'structured');
    if (updated?.kind === 'structured') {
      assert.deepStrictEqual(updated.sections, structured('Updated value').sections);
    }
  });

  it('accepts bounded visible text and explicit clearing', () => {
    const source = createAttachmentVoiceScreenSource({ resolveSurface: () => null });
    assert.deepStrictEqual(source.update({ kind: 'text', text: '  Visible answer  ' }), {
      status: 'updated',
    });
    assert.deepStrictEqual(source.read(), { kind: 'text', text: 'Visible answer' });
    assert.deepStrictEqual(source.update(null), { status: 'cleared' });
    assert.strictEqual(source.read(), null);
  });

  it('holds a not-yet-resolvable surface intent and starts answering when it renders', () => {
    let rendered = false;
    const source = createAttachmentVoiceScreenSource({
      resolveSurface: (surfaceId) =>
        surfaceId === 'surface-1' && rendered ? structured('Landed') : null,
    });
    assert.deepStrictEqual(source.update({ kind: 'surface', surfaceId: 'surface-1' }), {
      status: 'updated',
    });
    assert.strictEqual(source.read(), null, 'nothing resolves before the render lands');
    rendered = true;
    assert.strictEqual(source.read()?.kind, 'structured', 'the same intent self-heals');
  });

  it('clears rather than retaining stale context after invalid selections', () => {
    const source = createAttachmentVoiceScreenSource({
      resolveSurface: (surfaceId) => (surfaceId === 'surface-1' ? structured('Known') : null),
    });
    source.update({ kind: 'surface', surfaceId: 'surface-1' });
    source.update({ kind: 'text', text: 'Known text' });
    assert.deepStrictEqual(source.update({ kind: 'text', text: 'x'.repeat(4_001) }), {
      status: 'rejected',
      reason: 'oversized',
    });
    assert.strictEqual(source.read(), null);
  });
});

describe('buildVoiceScreen', () => {
  it('keeps sensitive values and fallback text out of the structured snapshot', () => {
    const components = new Map<string, A2uiComponentNode>([
      ['root', { id: 'root', component: 'Column', children: ['Form-1'] }],
      [
        'Form-1',
        {
          id: 'Form-1',
          component: 'Form',
          fields: [
            { id: 'name', label: 'Name', kind: 'text' },
            { id: 'password', label: 'Password', kind: 'password' },
          ],
        },
      ],
    ]);
    const surface: ReducedSurface = {
      surfaceId: 'surface-1',
      catalogId: 'catalog-1',
      fallbackMarkdown: 'Name Anna, password secret',
      components,
    };

    const screen = buildVoiceScreen(
      surface,
      { surfaces: { 'surface-1': { form: { name: 'Anna', password: 'secret' } } } },
      'surface-1',
    );

    assert.ok(screen);
    assert.strictEqual(screen.fallbackMarkdown, undefined);
    assert.strictEqual(screen.isSensitive?.('name'), false);
    assert.strictEqual(screen.isSensitive?.('password'), true);
  });
});
