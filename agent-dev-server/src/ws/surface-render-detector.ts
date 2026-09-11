import type {
  ObservedComponentContent,
  UIRenderDetection,
  UIRenderDetector,
} from '../../vendor/agentplace-voice/turn-observer.ts';
import type { PendingAction } from '../../vendor/agentplace-voice/turn-events.ts';
import { isRecord } from '../util/type-guards.ts';

const SURFACE_COMPONENT_NAME = 'Surface';

/**
 * Deployed-runtime `UIRenderDetector`: the only rendered unit the deployed
 * template knows about is the `Surface` component. Its contract fact —
 * `props.pendingAction` ({component,label}) — is
 * authored by the rendering tool; anything else (progress components,
 * non-UI tools) is plain telemetry and yields `null`.
 */
export class SurfaceRenderDetector implements UIRenderDetector {
  detect(content: ObservedComponentContent): UIRenderDetection | null {
    if (content.componentName !== SURFACE_COMPONENT_NAME) {
      return null;
    }
    return {
      component: SURFACE_COMPONENT_NAME,
      pendingAction: extractPendingAction(content.props['pendingAction']),
      fallbackMarkdown: content.fallbackMarkdown ?? null,
    };
  }
}

/**
 * Deployed surfaces resolve by the visitor answering in the next turn — there
 * is no `resumeToolResults` wiring yet, so `resume` always stays `null` and
 * `options` empty. The builder migration's detector fills both from its
 * blocking-tool contract (see docs/architecture/voice.md §3).
 */
function extractPendingAction(value: unknown): PendingAction | null {
  if (!isRecord(value)) {
    return null;
  }
  const { component, label } = value;
  if (typeof component !== 'string' || typeof label !== 'string') {
    return null;
  }
  return { component, label, options: [], resume: null };
}
