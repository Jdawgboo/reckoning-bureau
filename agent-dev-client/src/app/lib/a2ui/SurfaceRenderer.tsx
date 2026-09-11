/**
 * Renders one A2UI surface: walker-resolved tree → React catalog components.
 * Observer: re-renders when the surface (A2uiSurfaceStore) or its data model
 * (UiStateStore, `/surfaces/{surfaceId}`) changes. Contains a local error
 * boundary on purpose — a malformed surface must never crash the chat.
 *
 * Exposes a per-surface `A2uiSurfaceApi`: pointer reads/writes scoped to
 * `/surfaces/{surfaceId}`, and `submit()` — the only store-write path a
 * catalog component gets, reached exclusively via ButtonView.
 */
import { Component, useState, type FC, type ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';
import { useMessagingStore } from '@/app/lib/hooks';
import { wsManager } from '@/app/lib/services/websocket-manager';
import { isSensitiveFieldKind } from '../../../../vendor/agentplace-a2ui/field-sensitivity.ts';
import { isRecord } from '../util/type-guards.ts';
import { resolveSurface, type ResolvedNode } from '../../../../vendor/agentplace-a2ui/walker.ts';
import { evaluateChecks } from '../../../../vendor/agentplace-a2ui/functions.ts';
import {
  collectCheckedNodes,
  readActionEvent,
  resolveActionContext,
} from '../../../../vendor/agentplace-a2ui/actions.ts';
import { A2uiSurfaceContext, type A2uiSurfaceApi } from './surface-context.ts';
import { A2UI_REACT_CATALOG, A2uiFallback } from './catalog.tsx';
// Agent-zone registry: the components THIS agent declares.
import { AGENT_SURFACE_COMPONENTS } from '@/app/agent/surfaces/index.ts';
import { BUILTIN_SURFACE_COMPONENTS } from './builtin-catalog/index.ts';
import { messages } from '../localization/messages.ts';

class SurfaceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <FormattedMessage {...messages.viewCouldNotDisplay} />
        </div>
      );
    }
    return this.props.children;
  }
}

const NodeView: FC<{ node: ResolvedNode }> = ({ node }) => {
  const Renderer =
    AGENT_SURFACE_COMPONENTS[node.component] ??
    BUILTIN_SURFACE_COMPONENTS[node.component] ??
    (node.known ? A2UI_REACT_CATALOG[node.component] : undefined);
  const renderChildren = () => (
    <>
      {node.children.map((child) => (
        <NodeView key={child.id} node={child} />
      ))}
    </>
  );
  if (!Renderer) {
    return <A2uiFallback node={node} renderChildren={renderChildren} />;
  }
  return <Renderer node={node} renderChildren={renderChildren} />;
};

export const SurfaceRenderer: FC<{ surfaceId: string }> = observer(({ surfaceId }) => {
  const messagesStore = useMessagingStore();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const surface = messagesStore.a2uiSurfaces.surfaces.get(surfaceId);

  const scopedPointer = (pointer: string) => `/surfaces/${surfaceId}${pointer}`;
  const readState = (pointer: string): unknown => messagesStore.uiState.get(pointer);

  const dataModel = (readState(`/surfaces/${surfaceId}`) as Record<string, unknown>) ?? {};
  const tree = surface ? resolveSurface(surface, dataModel) : null;

  /** Shared submit tail: full-doc state sync, then a new turn carrying the
   *  a2uiAction metadata. Both `submit` (checks-gated button) and `dispatch`
   *  (signature components, already-resolved context) funnel through this
   *  single send path. */
  const sendAction = async (name: string, context: Record<string, unknown>, label: string) => {
    try {
      await wsManager.stateUpdate(toJS(messagesStore.uiState.state));
      messagesStore.uiState.markSynced();
    } catch (error) {
      console.error('[SurfaceRenderer] stateUpdate failed', error);
    }
    await messagesStore.sendMessage({
      instruction: label,
      metadata: { a2uiAction: { surfaceId, name, context } },
    });
  };

  /** Field ids whose values must never leave the browser, read from the
   *  rendered tree's own `kind` declarations. */
  const sensitiveFieldIds = collectSensitiveFieldIds(tree);

  /** Blur-time sync: the agent sees the form in progress, minus anything
   *  sensitive. Deliberately does not `markSynced()` — the server's copy is
   *  partial, so an incoming snapshot must still lose to what is on screen. */
  const commitTypedValues = async (): Promise<void> => {
    if (sensitiveFieldIds === null) {
      return;
    }
    try {
      const doc = messagesStore.uiState.syncableState((pointer) =>
        sensitiveFieldIds.some((id) => pointer.endsWith(`/${id}`)),
      );
      await wsManager.stateUpdate(toJS(doc));
    } catch (error) {
      console.error('[SurfaceRenderer] blur stateUpdate failed', error);
    }
  };

  const submit = async (node: ResolvedNode): Promise<void> => {
    if (!tree) {
      return;
    }
    const checkedNodes: ResolvedNode[] = [];
    collectCheckedNodes(tree, checkedNodes);

    const nextErrors: Record<string, string[]> = {};
    let anyFailed = false;
    const surfaceDataModel = readState(`/surfaces/${surfaceId}`) ?? {};
    for (const checkedNode of checkedNodes) {
      const result = evaluateChecks(checkedNode.props.checks, surfaceDataModel);
      if (!result.ok) {
        nextErrors[checkedNode.id] = result.messages;
        anyFailed = true;
      }
    }
    setErrors(nextErrors);
    if (anyFailed) {
      return;
    }

    const actionEvent = readActionEvent(node.props.action);
    if (!actionEvent) {
      return;
    }
    const resolvedContext = resolveActionContext(actionEvent.context, (pointer) =>
      readState(scopedPointer(pointer)),
    );
    const label = typeof node.props.label === 'string' ? node.props.label : actionEvent.name;
    await sendAction(actionEvent.name, resolvedContext, label);
  };

  const api: A2uiSurfaceApi = {
    getValue: (pointer) => readState(scopedPointer(pointer)),
    setValue: (pointer, value) => {
      messagesStore.uiState.setLocal(scopedPointer(pointer), value);
    },
    submit: (node) => {
      void submit(node);
    },
    dispatch: (name, context) => {
      void sendAction(name, context, name);
    },
    commitValue: () => {
      void commitTypedValues();
    },
    errorsFor: (nodeId) => errors[nodeId] ?? [],
  };

  if (!surface || !tree) {
    return null; // no root yet — progressive stream still arriving
  }
  return (
    <SurfaceErrorBoundary>
      <A2uiSurfaceContext.Provider value={api}>
        <NodeView node={tree} />
      </A2uiSurfaceContext.Provider>
    </SurfaceErrorBoundary>
  );
});

/** Walk the resolved tree for field declarations and return the ids whose
 *  `kind` is withheld from state sync. Returns `null` when there is no tree. */
function collectSensitiveFieldIds(tree: ResolvedNode | null): string[] | null {
  if (!tree) {
    return null;
  }
  const ids: string[] = [];
  const visit = (node: ResolvedNode): void => {
    const fields = node.props.fields;
    if (Array.isArray(fields)) {
      for (const field of fields) {
        if (isRecord(field) && typeof field.id === 'string' && isSensitiveFieldKind(field.kind)) {
          ids.push(field.id);
        }
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(tree);
  return ids;
}
