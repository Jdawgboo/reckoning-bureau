import assert from 'node:assert';
import { describe, it } from 'node:test';
import { AgentSession } from './agent-session.ts';

function makeSession(): AgentSession {
  return new AgentSession({
    sessionKey: 'voice-screen',
    userId: 'user-1',
    configId: 'agent-1',
    ttlMs: 60_000,
  });
}

function renderSurface(session: AgentSession, surfaceId: string, title: string): void {
  session.recordA2uiEvent({
    type: 'CUSTOM',
    name: 'agentplace.a2ui.createSurface',
    value: { surfaceId, catalogId: 'catalog-1' },
  });
  session.recordA2uiEvent({
    type: 'CUSTOM',
    name: 'agentplace.a2ui.updateComponents',
    value: {
      surfaceId,
      components: [
        { id: 'root', component: 'Column', children: [`Card-${surfaceId}`] },
        { id: `Card-${surfaceId}`, component: 'Card', title },
      ],
    },
  });
}

describe('AgentSession.screenForVoice', () => {
  it('resolves the browser-selected surface to its current state, and only rendered surfaces', () => {
    const session = makeSession();
    renderSurface(session, 'surface-1', 'First');
    renderSurface(session, 'surface-2', 'Second');

    assert.deepStrictEqual(session.screenForVoice('surface-1')?.sections, [
      { component: 'Card', props: { title: 'First' } },
    ]);
    assert.deepStrictEqual(session.screenForVoice('surface-2')?.sections, [
      { component: 'Card', props: { title: 'Second' } },
    ]);
    assert.strictEqual(session.screenForVoice('unknown'), null);
  });

  it('resolves a default single-root render — the shape RenderTable and RenderChart emit', () => {
    const session = makeSession();
    session.recordA2uiEvent({
      type: 'CUSTOM',
      name: 'agentplace.a2ui.createSurface',
      value: { surfaceId: 'demo-test-table', catalogId: 'catalog-1' },
    });
    // buildSurfaceEvents without a compose hook emits exactly one node:
    // the component itself as the root, no children array.
    session.recordA2uiEvent({
      type: 'CUSTOM',
      name: 'agentplace.a2ui.updateComponents',
      value: {
        surfaceId: 'demo-test-table',
        components: [{ id: 'root', component: 'Table', title: 'Demo Table' }],
      },
    });

    assert.deepStrictEqual(session.screenForVoice('demo-test-table')?.sections, [
      { component: 'Table', props: { title: 'Demo Table' } },
    ]);
  });

  it('resolves a re-rendered surface to what the visitor sees now', () => {
    const session = makeSession();
    renderSurface(session, 'surface-1', 'First');
    renderSurface(session, 'surface-1', 'Updated');

    assert.deepStrictEqual(session.screenForVoice('surface-1')?.sections, [
      { component: 'Card', props: { title: 'Updated' } },
    ]);
  });
});
