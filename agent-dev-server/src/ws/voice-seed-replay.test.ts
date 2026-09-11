import { describe, it } from 'node:test';
import assert from 'node:assert';
import { seedLedgerFromHistory, type SeedLedgerProjector } from './voice-seed-replay.ts';
import { VoiceContextProjector } from '../../vendor/agentplace-voice/voice-context-projector.ts';
import type {
  UIRenderDetector,
  UIRenderDetection,
} from '../../vendor/agentplace-voice/turn-observer.ts';
import type { TurnEvent } from '../../vendor/agentplace-voice/turn-events.ts';
import {
  createTextContent,
  createComponent,
  type AgentContent,
} from '../bl/agent/agent-library.ts';
import type { StoredContent } from './agent-session.types.ts';

function stored(...contents: AgentContent[]): StoredContent[] {
  return contents.map((content, seq) => ({ seq, timestamp: 0, content }));
}

function answeredRun(params: { runId: string; question: string; answer: string }): AgentContent[] {
  return [
    createTextContent({
      messageId: `${params.runId}-u`,
      responseId: params.runId,
      content: params.question,
      role: 'user',
    }),
    createTextContent({
      messageId: `${params.runId}-a`,
      responseId: params.runId,
      content: params.answer,
    }),
  ];
}

function renderedSurface(params: {
  runId: string;
  component: string;
  summary: string;
}): AgentContent {
  return createComponent({
    messageId: `${params.runId}-surface`,
    responseId: params.runId,
    componentName: 'Surface',
    props: { component: params.component },
    fallbackMarkdown: params.summary,
    streaming: {
      toolName: 'RenderSurface',
      toolCallId: `${params.runId}-call`,
      state: 'output-available',
    },
  });
}

/** Mirrors `surface-render-detector.ts`'s contract without importing it —
 *  keeps this suite decoupled from the deployed runtime's detector choice. */
class FakeSurfaceDetector implements UIRenderDetector {
  detect(content: Parameters<UIRenderDetector['detect']>[0]): UIRenderDetection | null {
    if (content.componentName !== 'Surface') {
      return null;
    }
    const component = content.props['component'];
    return {
      component: typeof component === 'string' ? component : 'Surface',
      pendingAction: null,
      fallbackMarkdown: content.fallbackMarkdown ?? null,
    };
  }
}

function fakeProjector(): {
  projector: SeedLedgerProjector;
  events: Array<{ runId: string; event: TurnEvent; requestText: string | null }>;
  outcomes: Array<{ runId: string; outcome: 'full' | 'partial' }>;
} {
  const events: Array<{ runId: string; event: TurnEvent; requestText: string | null }> = [];
  const outcomes: Array<{ runId: string; outcome: 'full' | 'partial' }> = [];
  return {
    projector: {
      onEvent: (runId, event, requestText) => events.push({ runId, event, requestText }),
      noteRelayOutcome: (runId, outcome) => outcomes.push({ runId, outcome }),
    },
    events,
    outcomes,
  };
}

function realProjector(): { projector: VoiceContextProjector; lines: string[] } {
  const lines: string[] = [];
  const projector = new VoiceContextProjector({
    appendLedger: (line) => lines.push(line),
    stripMarkdown: (markdown) => markdown,
    screen: { kind: 'summary' },
  });
  return { projector, lines };
}

describe('seedLedgerFromHistory — empty history', () => {
  it('seeds nothing and reports a zero summary', () => {
    const { projector, events, outcomes } = fakeProjector();
    const summary = seedLedgerFromHistory({
      contents: [],
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(outcomes.length, 0);
    assert.deepStrictEqual(summary, { runs: 0, surfaces: 0 });
  });
});

describe('seedLedgerFromHistory — one Delivered line per answered run', () => {
  it('writes ledger lines for every run in chronological order', () => {
    const { projector, lines } = realProjector();
    const contents = stored(
      ...answeredRun({ runId: 'r1', question: 'what are your hours?', answer: 'We open at nine.' }),
      ...answeredRun({ runId: 'r2', question: 'do you have parking?', answer: 'Yes, out back.' }),
    );
    seedLedgerFromHistory({
      contents,
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.deepStrictEqual(lines, [
      'Delivered (spoken-full): visitor asked "what are your hours?" — We open at nine.',
      'Delivered (spoken-full): visitor asked "do you have parking?" — Yes, out back.',
    ]);
  });

  it('resolves the outcome synchronously — no timer left pending', () => {
    const { projector, events, outcomes } = fakeProjector();
    const contents = stored(
      ...answeredRun({ runId: 'r1', question: 'hours?', answer: 'Nine to five.' }),
    );
    seedLedgerFromHistory({
      contents,
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.deepStrictEqual(
      events.map((e) => e.event.type),
      ['answer-text', 'run-finished'],
    );
    assert.deepStrictEqual(outcomes, [{ runId: 'r1', outcome: 'full' }]);
  });
});

describe('seedLedgerFromHistory — screen state from the last surface', () => {
  it('screenStateBlock reflects the most recently rendered surface after seeding, and the summary counts both surfaces', () => {
    const { projector } = realProjector();
    const contents = stored(
      renderedSurface({ runId: 'r1', component: 'ContactForm', summary: 'a contact form' }),
      renderedSurface({ runId: 'r2', component: 'OptionGrid', summary: 'size options' }),
    );
    const summary = seedLedgerFromHistory({
      contents,
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.strictEqual(
      projector.screenStateBlock(),
      'LATEST DELIVERED RESULT: OptionGrid — size options',
    );
    assert.deepStrictEqual(summary, { runs: 2, surfaces: 2 });
  });
});

describe('seedLedgerFromHistory — screen-originated runs have no request text', () => {
  it('a run with no user message reads as "visitor asked (on screen)"', () => {
    const { projector, lines } = realProjector();
    const contents = stored(
      createTextContent({ messageId: 'a1', responseId: 'r1', content: 'Here it is.' }),
    );
    seedLedgerFromHistory({
      contents,
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.deepStrictEqual(lines, [
      'Delivered (spoken-full): visitor asked (on screen) — Here it is.',
    ]);
  });
});

describe('seedLedgerFromHistory — caps at the last 8 runs', () => {
  it('drops runs older than the most recent 8', () => {
    const { projector, events } = fakeProjector();
    const runs: AgentContent[] = [];
    for (let i = 0; i < 10; i += 1) {
      runs.push(...answeredRun({ runId: `r${i}`, question: `q${i}`, answer: `a${i}` }));
    }
    seedLedgerFromHistory({
      contents: stored(...runs),
      projector,
      detector: new FakeSurfaceDetector(),
    });
    const seenRunIds = [...new Set(events.map((e) => e.runId))];
    assert.deepStrictEqual(seenRunIds, ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  });

  it('does not let voice-only delivery records displace ordinary agent runs', () => {
    const { projector, events } = fakeProjector();
    const runs: AgentContent[] = [];
    for (let i = 0; i < 8; i += 1) {
      runs.push(...answeredRun({ runId: `r${i}`, question: `q${i}`, answer: `a${i}` }));
    }
    for (let i = 0; i < 12; i += 1) {
      runs.push(
        createTextContent({
          messageId: `voice-${i}`,
          responseId: `voice-${i}`,
          content: `spoken ${i}`,
          hidden: true,
          channel: 'voice',
          voiceDelivery: { kind: 'narration', status: 'full' },
        }),
      );
    }
    seedLedgerFromHistory({
      contents: stored(...runs),
      projector,
      detector: new FakeSurfaceDetector(),
    });
    const seenRunIds = [...new Set(events.map((event) => event.runId))];
    assert.deepStrictEqual(seenRunIds, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });
});

describe('seedLedgerFromHistory — items without a responseId are ignored', () => {
  it('does not seed content that cannot be grouped into a run', () => {
    const { projector, events, outcomes } = fakeProjector();
    const contents = stored(createTextContent({ messageId: 'orphan', content: 'stray text' }));
    const summary = seedLedgerFromHistory({
      contents,
      projector,
      detector: new FakeSurfaceDetector(),
    });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(outcomes.length, 0);
    assert.deepStrictEqual(summary, { runs: 0, surfaces: 0 });
  });
});
