import assert from 'node:assert';
import { describe, it } from 'node:test';

import { hydrateSession, type HydrationSession } from './session-hydration.ts';
import {
  createComponent,
  createTextContent,
  type AgentContent,
  type AguiEvent,
} from '../bl/agent/agent-library.ts';

function createSession(hasActiveRun = false) {
  const pushed: AgentContent[] = [];
  const recorded: Array<{ event: AguiEvent; responseId: string | undefined }> = [];
  const session: HydrationSession & {
    pushed: AgentContent[];
    recorded: typeof recorded;
  } = {
    sessionKey: 'sess-recreate',
    hasActiveRun,
    pushed,
    recorded,
    pushContent(content) {
      pushed.push(content);
    },
    recordA2uiEvent(event, responseId) {
      recorded.push({ event, responseId });
    },
  };
  return session;
}

/** A CONTENT#-shaped Surface record carrying the composed A2UI events the
 *  Surface tool persisted into `uiProps.surfaceReplay` (see
 *  `render-surface.tool.ts`). */
function contentSurfaceRecord(
  messageId: string,
  responseId: string,
  surfaceId: string,
  component: string,
  surfaceReplay: Array<{ name: string; value: unknown }>,
): AgentContent {
  return createComponent({
    messageId,
    responseId,
    componentName: 'Surface',
    props: { surfaceId, component, surfaceReplay },
  });
}

const CREATE_SURFACE_EVENT = {
  name: 'agentplace.a2ui.createSurface',
  value: { surfaceId: 'card-1' },
};
const UPDATE_COMPONENTS_EVENT = {
  name: 'agentplace.a2ui.updateComponents',
  value: { components: [{ id: 'root', component: 'Card', question: 'Vegan options?' }] },
};

function eventName(recorded: { event: AguiEvent }): string {
  const event = recorded.event as { type: 'CUSTOM'; name: string; value: unknown };
  return event.name;
}

describe('hydrateSession', () => {
  it('a genuinely new session (no persisted content at all) records and pushes nothing', async () => {
    const session = createSession();
    await hydrateSession(session, { loadContent: async () => [] });
    assert.strictEqual(session.pushed.length, 0);
    assert.strictEqual(session.recorded.length, 0);
  });

  it('primes text content into the replay buffer', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [createTextContent({ messageId: 'm1', content: 'hello' })],
    });
    assert.strictEqual(session.pushed.length, 1);
  });

  it('idle session: primes mixed text and component content into the replay buffer', async () => {
    const session = createSession(false);
    await hydrateSession(session, {
      loadContent: async () => [
        createTextContent({ messageId: 'm1', content: 'searching' }),
        contentSurfaceRecord('call_1', 'resp-1', 'card-1', 'Card', [CREATE_SURFACE_EVENT]),
      ],
    });
    assert.strictEqual(session.pushed.length, 2);
  });

  it('session with a live local run: does not push content into the replay buffer (avoids racing live pushContent)', async () => {
    const session = createSession(true);
    await hydrateSession(session, {
      loadContent: async () => [
        createTextContent({ messageId: 'm1', content: 'hi' }),
        createTextContent({ messageId: 'm2', content: 'hello' }),
      ],
    });
    assert.strictEqual(session.pushed.length, 0);
  });

  it('regression: a stale "processing" summary with no local run attached still buffers — the guard keys on hasActiveRun, not status', async () => {
    const session = createSession(false);
    await hydrateSession(session, {
      loadContent: async () => [
        createTextContent({ messageId: 'm1', content: 'hi' }),
        createTextContent({ messageId: 'm2', content: 'hello' }),
      ],
    });
    assert.strictEqual(session.pushed.length, 2);
  });

  it('swallows loadContent errors and reports via onError', async () => {
    const session = createSession();
    const errors: unknown[] = [];
    await assert.doesNotReject(
      hydrateSession(session, {
        loadContent: async () => {
          throw new Error('DDB unavailable');
        },
        onError: (e) => errors.push(e),
      }),
    );
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(session.pushed.length, 0);
    assert.strictEqual(session.recorded.length, 0);
  });

  it('does not require onError to be defined when loadContent throws', async () => {
    const session = createSession();
    await assert.doesNotReject(
      hydrateSession(session, {
        loadContent: async () => {
          throw new Error('no listener');
        },
      }),
    );
    assert.strictEqual(session.pushed.length, 0);
  });

  it('replays a stored surface payload into the session', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [
        contentSurfaceRecord('call_1', 'resp-1', 'card-1', 'Card', [
          CREATE_SURFACE_EVENT,
          UPDATE_COMPONENTS_EVENT,
        ]),
      ],
    });

    assert.strictEqual(session.recorded.length, 2);
    assert.strictEqual(session.recorded[0].responseId, 'resp-1');
    assert.strictEqual(session.recorded[1].responseId, 'resp-1');
    assert.strictEqual(eventName(session.recorded[0]), 'agentplace.a2ui.createSurface');
    assert.strictEqual(eventName(session.recorded[1]), 'agentplace.a2ui.updateComponents');
    assert.deepStrictEqual(
      (session.recorded[1].event as { value: unknown }).value,
      UPDATE_COMPONENTS_EVENT.value,
    );
  });

  it('keeps only the LAST render per surfaceId', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [
        contentSurfaceRecord('call_1', 'resp-1', 'card-1', 'Card', [
          { name: 'agentplace.a2ui.createSurface', value: { surfaceId: 'card-1', revision: 1 } },
        ]),
        contentSurfaceRecord('call_2', 'resp-2', 'card-1', 'Card', [
          { name: 'agentplace.a2ui.createSurface', value: { surfaceId: 'card-1', revision: 2 } },
        ]),
      ],
    });

    assert.strictEqual(session.recorded.length, 1);
    assert.strictEqual(session.recorded[0].responseId, 'resp-2');
    assert.deepStrictEqual((session.recorded[0].event as { value: unknown }).value, {
      surfaceId: 'card-1',
      revision: 2,
    });
  });

  it('skips a record with no surfaceReplay (session created before the fix)', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [
        createComponent({
          messageId: 'call_1',
          responseId: 'resp-1',
          componentName: 'Surface',
          props: { surfaceId: 'card-1', component: 'Card' },
        }),
      ],
    });
    assert.strictEqual(session.recorded.length, 0);
  });

  it('skips a malformed surfaceReplay payload', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [
        createComponent({
          messageId: 'call_1',
          responseId: 'resp-1',
          componentName: 'Surface',
          props: { surfaceId: 'card-1', component: 'Card', surfaceReplay: 'nope' },
        }),
        createComponent({
          messageId: 'call_2',
          responseId: 'resp-2',
          componentName: 'Surface',
          props: { surfaceId: 'card-2', component: 'Card', surfaceReplay: [{}] },
        }),
      ],
    });
    assert.strictEqual(session.recorded.length, 0);
  });

  it('survives a JSON round trip of the content record', async () => {
    const session = createSession();
    const records: AgentContent[] = [
      contentSurfaceRecord('call_1', 'resp-1', 'card-1', 'Card', [
        CREATE_SURFACE_EVENT,
        UPDATE_COMPONENTS_EVENT,
      ]),
    ];
    await hydrateSession(session, {
      loadContent: async () => JSON.parse(JSON.stringify(records)) as AgentContent[],
    });

    assert.strictEqual(session.recorded.length, 2);
    assert.strictEqual(session.recorded[0].responseId, 'resp-1');
    assert.strictEqual(eventName(session.recorded[0]), 'agentplace.a2ui.createSurface');
    assert.strictEqual(eventName(session.recorded[1]), 'agentplace.a2ui.updateComponents');
    assert.deepStrictEqual(
      (session.recorded[1].event as { value: unknown }).value,
      UPDATE_COMPONENTS_EVENT.value,
    );
  });
});

describe('replayStoredSurfaces — self-sufficiency', () => {
  it('skips a patch-only record rather than letting it blank the screen', async () => {
    const session = createSession();
    await hydrateSession(session, {
      loadContent: async () => [
        contentSurfaceRecord('call_1', 'resp-1', 'card-1', 'Card', [
          { name: 'agentplace.a2ui.createSurface', value: { surfaceId: 'card-1', revision: 1 } },
        ]),
        // A later record for the same surface carrying no createSurface frame.
        // Replayed alone it hits the store's unknown-surface branch and is
        // dropped, so the screen would restore as nothing.
        contentSurfaceRecord('call_2', 'resp-2', 'card-1', 'Card', [
          {
            name: 'agentplace.a2ui.updateComponents',
            value: { surfaceId: 'card-1', components: [] },
          },
        ]),
      ],
    });

    assert.strictEqual(session.recorded.length, 1);
    assert.strictEqual(session.recorded[0].responseId, 'resp-1');
    assert.deepStrictEqual((session.recorded[0].event as { value: unknown }).value, {
      surfaceId: 'card-1',
      revision: 1,
    });
  });
});
