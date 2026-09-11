import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SurfaceRenderDetector } from './surface-render-detector.ts';
import type { ObservedComponentContent } from '../../vendor/agentplace-voice/turn-observer.ts';

function surfaceContent(
  props: Record<string, unknown>,
  extra: { fallbackMarkdown?: string } = {},
): ObservedComponentContent {
  return {
    type: 'Component',
    messageId: 'm1',
    componentName: 'Surface',
    props,
    fallbackMarkdown: extra.fallbackMarkdown,
  };
}

describe('SurfaceRenderDetector', () => {
  it('returns full contract facts for a fully populated Surface', () => {
    const detector = new SurfaceRenderDetector();
    const detection = detector.detect(
      surfaceContent(
        {
          pendingAction: { component: 'ContactForm', label: 'The contact form is on screen.' },
        },
        { fallbackMarkdown: '**Contact form**' },
      ),
    );
    assert.deepStrictEqual(detection, {
      component: 'Surface',
      pendingAction: {
        component: 'ContactForm',
        label: 'The contact form is on screen.',
        options: [],
        resume: null,
      },
      fallbackMarkdown: '**Contact form**',
    });
  });

  it('returns null pendingAction when props.pendingAction is missing', () => {
    const detector = new SurfaceRenderDetector();
    const detection = detector.detect(surfaceContent({}));
    assert.ok(detection);
    assert.strictEqual(detection?.pendingAction, null);
  });

  it('returns null pendingAction when props.pendingAction is not a record', () => {
    const detector = new SurfaceRenderDetector();
    const detection = detector.detect(surfaceContent({ pendingAction: 'not-an-object' }));
    assert.ok(detection);
    assert.strictEqual(detection?.pendingAction, null);
  });

  it('returns null pendingAction when component or label has the wrong type', () => {
    const detector = new SurfaceRenderDetector();
    const missingLabel = detector.detect(
      surfaceContent({ pendingAction: { component: 'ContactForm' } }),
    );
    assert.strictEqual(missingLabel?.pendingAction, null);

    const wrongType = detector.detect(
      surfaceContent({ pendingAction: { component: 42, label: 'The form is on screen.' } }),
    );
    assert.strictEqual(wrongType?.pendingAction, null);
  });

  it('returns null fallbackMarkdown when the content has none', () => {
    const detector = new SurfaceRenderDetector();
    const detection = detector.detect(surfaceContent({}));
    assert.strictEqual(detection?.fallbackMarkdown, null);
  });

  it('returns null for a non-Surface component', () => {
    const detector = new SurfaceRenderDetector();
    const detection = detector.detect({
      type: 'Component',
      messageId: 'm1',
      componentName: 'RenderTable',
      props: { pendingAction: { component: 'ContactForm', label: 'ignored' } },
    });
    assert.strictEqual(detection, null);
  });
});
