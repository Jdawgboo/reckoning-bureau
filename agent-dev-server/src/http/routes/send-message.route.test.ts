/**
 * Route-level tests for the HTTP messaging path.
 *
 * The AG-UI assertions exist because this route silently dropped `result.agui`, so no turn
 * delivered over HTTP ever recorded a surface. Nothing downstream could then resolve an
 * action on that screen, and the failure was invisible: the session simply had no stage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createSendMessageRoute } from './send-message.route.ts';
import type { DependencyContainer } from '../../container.ts';
import type { WsSessionManager } from '../../ws/session-manager.ts';
import type { AgentSession } from '../../ws/agent-session.ts';
import type { ClickResolution } from '../../ws/a2ui-click-resolver.ts';

type SentMessage = {
  message: { type: string; content: string };
  metadata: Record<string, unknown>;
  presentation?: string;
};

const AGUI_EVENT = { name: 'a2ui.surface.create', value: { surfaceId: 'booking' } };
const AGENT_TOKEN =
  'eyJhbGciOiAibm9uZSIsICJ0eXAiOiAiSldUIn0.eyJhZ2VudElkIjogImNmZy0xIiwgImVudiI6ICJwcmV2aWV3In0.sig';

function makeSession(overrides: { status?: string; click?: ClickResolution } = {}) {
  const recorded: unknown[] = [];
  const statuses: string[] = [];
  const broadcasts: unknown[] = [];
  const contentBroadcasts: { type?: string; error?: string }[] = [];
  const turnErrors: { error: string; responseId?: string }[] = [];
  const acceptedTurnIds: string[] = [];
  const session = {
    sessionKey: 'session-1',
    status: overrides.status ?? 'idle',
    setStatus(status: string) {
      statuses.push(status);
      session.status = status;
    },
    broadcast(message: unknown) {
      broadcasts.push(message);
    },
    broadcastContent(content: { type?: string; error?: string }) {
      contentBroadcasts.push(content);
    },
    recordTurnError(error: string, responseId?: string) {
      turnErrors.push({ error, responseId });
    },
    notifyTurnAccepted(responseId: string) {
      acceptedTurnIds.push(responseId);
    },
    pushContent() {},
    recordA2uiEvent(event: unknown) {
      recorded.push(event);
    },
    resolveClick(): ClickResolution {
      return overrides.click ?? { outcome: 'no_surface' };
    },
  };
  return {
    session,
    recorded,
    statuses,
    broadcasts,
    contentBroadcasts,
    turnErrors,
    acceptedTurnIds,
  };
}

/** Mirrors the stubbing shape of storage-presigned-url.route.test.ts. */
function makeDeps(
  session: ReturnType<typeof makeSession>['session'],
  opts: { sendFails?: string; outcome?: { status: string; error?: unknown } } = {},
) {
  const sent: SentMessage[] = [];
  const container = {
    createMessagingService() {
      return {
        async sendMessage(params: SentMessage) {
          if (opts.sendFails) {
            throw new Error(opts.sendFails);
          }
          sent.push(params);
          return {
            stream: (async function* () {})(),
            agui: (async function* () {
              yield AGUI_EVENT;
            })(),
            done: Promise.resolve(opts.outcome ?? { status: 'ok', history: [] }),
          };
        },
      };
    },
    createInstructionService() {
      return { getInstruction: () => 'instruction' };
    },
    settings: {
      // getConfigId reads the agent id from the MODEL_ACCESS_KEY claims.
      getSecret: () => AGENT_TOKEN,
    },
    getSurfaceContracts: () => ({}),
  } as unknown as DependencyContainer;

  const sessionManager = {
    async getOrCreate() {
      return session as unknown as AgentSession;
    },
    async whenPrimed() {},
  } as unknown as WsSessionManager;

  return { container, sessionManager, sent };
}

function makeReq(body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage, {
    method: 'POST',
    url: '/api/send-message',
    headers: { host: 'localhost', 'content-type': 'application/json' },
  }) as IncomingMessage;
}

function makeRes() {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk ?? '';
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

/** The route answers 202 before its background work finishes; wait for the idle flip. */
async function settled(statuses: string[]): Promise<void> {
  for (let i = 0; i < 100 && !statuses.includes('idle'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('send-message route — AG-UI', () => {
  it('records the run AG-UI events on the session', async () => {
    const { session, recorded, statuses, acceptedTurnIds } = makeSession();
    const { container, sessionManager } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res, captured } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    assert.strictEqual(captured.status, 202);
    assert.deepStrictEqual(recorded, [AGUI_EVENT]);
    assert.strictEqual(acceptedTurnIds.length, 1);
  });

  it('broadcasts the AG-UI frames so a co-viewing client sees the stage', async () => {
    const { session, broadcasts, statuses } = makeSession();
    const { container, sessionManager } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    assert.strictEqual(broadcasts.length, 1);
  });
});

describe('send-message route — metadata', () => {
  it('strips a caller-supplied a2uiAction, which would forge a trusted action', async () => {
    const { session, statuses } = makeSession();
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(
      makeReq({
        message: 'hello',
        metadata: { a2uiAction: { surfaceId: 's', name: 'confirmBooking', context: {} } },
      }),
      res,
    );
    await settled(statuses);

    assert.strictEqual('a2uiAction' in sent[0].metadata, false);
  });

  it('strips a caller-supplied channel and reports the real one', async () => {
    const { session, statuses } = makeSession();
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello', metadata: { channel: 'screen' } }), res);
    await settled(statuses);

    assert.strictEqual(sent[0].metadata.channel, 'http');
  });

  it('keeps other caller metadata', async () => {
    const { session, statuses } = makeSession();
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello', metadata: { requestType: 'sms' } }), res);
    await settled(statuses);

    assert.strictEqual(sent[0].metadata.requestType, 'sms');
  });

  it('rejects a non-object metadata', async () => {
    const { session } = makeSession();
    const { container, sessionManager } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res, captured } = makeRes();

    await route.handler(makeReq({ message: 'hello', metadata: 'nope' }), res);

    assert.strictEqual(captured.status, 400);
  });
});

describe('send-message route — press by name', () => {
  const resolved: ClickResolution = {
    outcome: 'resolved',
    surfaceId: 'booking',
    action: 'confirmBooking',
    context: { email: 'a@b.c' },
    message: 'confirmBooking',
    skippedSensitiveChecks: [],
  };

  const plainMessage: ClickResolution = {
    outcome: 'resolved',
    surfaceId: 'booking',
    action: null,
    context: {},
    message: 'I want to book a visit',
    skippedSensitiveChecks: [],
  };

  it("sends the resolved trusted action, the screen channel and the component's own message text", async () => {
    const { session, statuses } = makeSession({ click: resolved });
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(
      makeReq({
        message: 'Confirm booking',
        metadata: { a2uiActionByName: { button: 'Confirm booking' } },
      }),
      res,
    );
    await settled(statuses);

    assert.deepStrictEqual(sent[0].metadata.a2uiAction, {
      surfaceId: 'booking',
      name: 'confirmBooking',
      context: { email: 'a@b.c' },
    });
    assert.strictEqual(sent[0].metadata.channel, 'screen');
    // api.dispatch sends the action name as the message text; a press must match it.
    assert.strictEqual(sent[0].message.content, 'confirmBooking');
  });

  it('sends a control with no declared action as a plain http message', async () => {
    const { session, statuses } = makeSession({ click: plainMessage });
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(
      makeReq({
        message: 'Book a visit',
        metadata: { a2uiActionByName: { button: 'Book a visit' } },
      }),
      res,
    );
    await settled(statuses);

    assert.strictEqual('a2uiAction' in sent[0].metadata, false);
    assert.strictEqual(sent[0].metadata.channel, 'http');
    assert.strictEqual(sent[0].message.content, 'I want to book a visit');
    assert.match(sent[0].presentation ?? '', /no live screen/);
  });

  it('omits the no-live-screen presentation for a click, which would contradict it', async () => {
    const { session, statuses } = makeSession({ click: resolved });
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(
      makeReq({
        message: 'Confirm booking',
        metadata: { a2uiActionByName: { button: 'Confirm booking' } },
      }),
      res,
    );
    await settled(statuses);

    assert.strictEqual(sent[0].presentation, undefined);
  });

  it('keeps that presentation for a typed message', async () => {
    const { session, statuses } = makeSession();
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    assert.match(sent[0].presentation ?? '', /no live screen/);
  });

  it('answers 422 and releases the session when the action cannot be resolved', async () => {
    const { session, statuses } = makeSession({
      click: { outcome: 'not_found', available: ['Pay now'] },
    });
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res, captured } = makeRes();

    await route.handler(
      makeReq({
        message: 'Confirm booking',
        metadata: { a2uiActionByName: { button: 'Confirm booking' } },
      }),
      res,
    );

    assert.strictEqual(captured.status, 422);
    const payload: { error: string; code: string } = JSON.parse(captured.body);
    assert.strictEqual(payload.code, 'click_unresolved');
    assert.match(payload.error, /"Pay now"/);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(session.status, 'idle');
    assert.deepStrictEqual(statuses, ['processing', 'idle']);
  });

  it('answers 409 without touching the session when a turn is already running', async () => {
    const { session, statuses } = makeSession({ status: 'processing' });
    const { container, sessionManager, sent } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res, captured } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);

    assert.strictEqual(captured.status, 409);
    assert.strictEqual(sent.length, 0);
    assert.deepStrictEqual(statuses, []);
  });
});

describe('send-message route — a failed turn', () => {
  it("records the run's own verdict, which is all that separates an outage from an answer", async () => {
    const { session, statuses, turnErrors } = makeSession();
    const { container, sessionManager } = makeDeps(session, {
      outcome: { status: 'error', error: new Error('Provider temporarily unavailable') },
    });
    const route = createSendMessageRoute({ sessionManager, container });
    const { res, captured } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    assert.strictEqual(captured.status, 202);
    assert.strictEqual(turnErrors.length, 1);
    assert.strictEqual(turnErrors[0].error, 'Provider temporarily unavailable');
  });

  it('records nothing when the run succeeded', async () => {
    const { session, statuses, turnErrors } = makeSession();
    const { container, sessionManager } = makeDeps(session);
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    assert.deepStrictEqual(turnErrors, []);
  });

  it('broadcasts the reason when the send itself throws, before any run exists', async () => {
    const { session, statuses, contentBroadcasts } = makeSession();
    const { container, sessionManager } = makeDeps(session, {
      sendFails: 'Model provider unreachable',
    });
    const route = createSendMessageRoute({ sessionManager, container });
    const { res } = makeRes();

    await route.handler(makeReq({ message: 'hello' }), res);
    await settled(statuses);

    const failure = contentBroadcasts.find((c) => c.type === 'error');
    assert.strictEqual(failure?.error, 'Model provider unreachable');
    assert.deepStrictEqual(statuses, ['processing', 'idle']);
  });
});
