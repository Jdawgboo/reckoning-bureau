import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  findCarriedSurfaceId,
  isStageRunActive,
  resolveStageView,
  voiceScreenSelectionForStage,
  type StageView,
  type StageViewInput,
} from './stage-view.ts';

const voiceCopy = {
  transcriptOpen: 'The conversation transcript is open.',
  workInProgress: 'Work is in progress.',
  screenTextTruncated: '… [screen text truncated]',
};

function voiceSelection(options: Omit<Parameters<typeof voiceScreenSelectionForStage>[0], 'copy'>) {
  return voiceScreenSelectionForStage({ ...options, copy: voiceCopy });
}
import type { TurnEntry } from './turn-index.ts';

let turnIdCounter = 0;

function turn(overrides: Partial<TurnEntry>): TurnEntry {
  return {
    id: `turn-${turnIdCounter++}`,
    request: 'q',
    responsePreview: '',
    responseText: '',
    ...overrides,
  };
}

function input(overrides: Partial<StageViewInput>): StageViewInput {
  return {
    turns: [],
    selectedIndex: null,
    surfaces: [],
    processPartKey: null,
    userRequestPending: false,
    ...overrides,
  };
}

describe('voiceScreenSelectionForStage', () => {
  it('sends only the selected surface identity for a structured page', () => {
    assert.deepStrictEqual(
      voiceSelection({
        view: { kind: 'surface', key: 'surface:s2:live', surfaceId: 's2' },
        turns: [],
        chatMode: false,
        processNarration: '',
      }),
      { kind: 'surface', surfaceId: 's2' },
    );
  });

  it('projects the visible text page and process narration', () => {
    const turns = [turn({ responseText: 'The answer already on the page.' })];
    assert.deepStrictEqual(
      voiceSelection({
        view: { kind: 'text', key: 'text:0', turnIndex: 0 },
        turns,
        chatMode: false,
        processNarration: '',
      }),
      { kind: 'text', text: 'The answer already on the page.' },
    );
    assert.deepStrictEqual(
      voiceSelection({
        view: { kind: 'process', key: 'process:1', turnIndex: 0 },
        turns,
        chatMode: false,
        processNarration: 'Checking availability',
      }),
      { kind: 'text', text: 'Checking availability' },
    );
  });

  it('bounds a long visible text page without turning it into an absent screen', () => {
    const selection = voiceSelection({
      view: { kind: 'text', key: 'text:0', turnIndex: 0 },
      turns: [turn({ responseText: 'x'.repeat(5_000) })],
      chatMode: false,
      processNarration: '',
    });
    assert.strictEqual(selection?.kind, 'text');
    if (selection?.kind === 'text') {
      assert.strictEqual(selection.text.length, 4_000);
      assert.match(selection.text, /\[screen text truncated\]$/);
    }
  });

  it('distinguishes transcript and absent page states', () => {
    assert.deepStrictEqual(
      voiceSelection({
        view: { kind: 'loading', key: 'loading' },
        turns: [],
        chatMode: true,
        processNarration: '',
      }),
      { kind: 'text', text: 'The conversation transcript is open.' },
    );
    assert.strictEqual(
      voiceSelection({
        view: { kind: 'loading', key: 'loading' },
        turns: [],
        chatMode: false,
        processNarration: '',
      }),
      null,
    );
  });
});

describe('resolveStageView — live head', () => {
  it('matches the turn surface by responseId', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' })],
        surfaces: [
          { id: 'old', responseId: 'r0' },
          { id: 'mine', responseId: 'r1' },
        ],
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'surface', key: 'surface:mine:live', surfaceId: 'mine' });
  });

  it('restore fallback: identity-less turns (post-reload) show the latest resynced surface', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: undefined, responseText: 'restored text' })],
        surfaces: [{ id: 'restored-a' }, { id: 'restored-b' }],
      }),
      null,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:restored-b:live',
      surfaceId: 'restored-b',
    });
  });

  it('restore fallback also covers zero turns with resynced surfaces', () => {
    const page = resolveStageView(input({ surfaces: [{ id: 's1' }] }), null);
    assert.strictEqual(page.kind, 'surface');
  });

  it('REGRESSION (pending pre-empt): the fallback never fires during a request', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: undefined })],
        surfaces: [{ id: 'stale' }],
        userRequestPending: true,
      }),
      null,
    );
    assert.strictEqual(page.kind, 'loading');
  });

  it('process page while pending, keyed by the part', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' })],
        processPartKey: 'call-9',
        userRequestPending: true,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'process', key: 'process:call-9', turnIndex: 0 });
  });

  it('a voice-originated run earns the process page without a typed send', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' })],
        processPartKey: 'call-9',
        userRequestPending: false,
        voiceRunActive: true,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'process', key: 'process:call-9', turnIndex: 0 });
  });

  it('process part is ignored once the request ended (abort safety); the settled text page takes over', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'done' })],
        processPartKey: 'call-9',
        userRequestPending: false,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'text', key: 'text:0', turnIndex: 0 });
  });

  it('first paint with nothing at all: loading', () => {
    assert.deepStrictEqual(resolveStageView(input({}), null), {
      kind: 'loading',
      key: 'loading',
    });
  });

  it('pending with no process part and no held page: loading', () => {
    const page = resolveStageView(input({ userRequestPending: true }), null);
    assert.deepStrictEqual(page, { kind: 'loading', key: 'loading' });
  });
});

describe('resolveStageView — in flight: text never claims the page', () => {
  const heldSurface: StageView = {
    kind: 'surface',
    key: 'surface:services:live',
    surfaceId: 'services',
  };

  it('text accompanying the turn own surface: the surface wins the page', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'Here is the form you asked for.' })],
        surfaces: [{ id: 'fresh', responseId: 'r1' }],
        userRequestPending: true,
      }),
      null,
    );
    assert.strictEqual(page.kind, 'surface');
  });

  it('a typed text answer over a held surface HOLDS the surface (screen stays, text is not shown)', () => {
    const page = resolveStageView(
      input({
        turns: [
          turn({ responseId: 'r0' }),
          turn({ responseId: 'r1', responseText: 'No, that field is optional.' }),
        ],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(page, heldSurface);
  });

  it('the hold is channel-agnostic: a voice-channel text answer over a held surface also holds', () => {
    const page = resolveStageView(
      input({
        turns: [
          turn({ responseId: 'r0' }),
          turn({
            responseId: 'r1',
            responseText: 'This form covers everything you need.',
            channel: 'voice',
          }),
        ],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(page, heldSurface);
  });

  it('a contentless turn over a held surface keeps the held page', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0' }), turn({ responseId: 'r1' })],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(page, heldSurface);
  });
});

describe('resolveStageView — settled, text-only: the deferred text page', () => {
  const heldSurface: StageView = {
    kind: 'surface',
    key: 'surface:services:live',
    surfaceId: 'services',
  };

  it('a settled typed text-only turn with no held page becomes the deferred text page', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'We open at nine.' })],
        userRequestPending: false,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'text', key: 'text:0', turnIndex: 0 });
  });

  it('the deferred text page uses the same key format as the history text page (text:<index>)', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0' }), turn({ responseId: 'r1', responseText: 'Yes.' })],
        userRequestPending: false,
      }),
      null,
    );
    assert.strictEqual(page.kind, 'text');
    assert.strictEqual(page.kind === 'text' ? page.key : null, 'text:1');
  });

  it('a settled typed text-only turn with a prior surface SHOWS THAT SURFACE — the reply is conversation, not the page', () => {
    const page = resolveStageView(
      input({
        turns: [
          turn({ responseId: 'r0' }),
          turn({ responseId: 'r1', responseText: 'No, that field is optional.' }),
        ],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: false,
      }),
      heldSurface,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:services:live',
      surfaceId: 'services',
    });
  });

  it('a settled voice text-only turn over a held surface HOLDS the surface (spoken answer, screen keeps context)', () => {
    const page = resolveStageView(
      input({
        turns: [
          turn({ responseId: 'r0' }),
          turn({
            responseId: 'r1',
            responseText: 'This form covers everything you need.',
            channel: 'voice',
          }),
        ],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: false,
      }),
      heldSurface,
    );
    assert.strictEqual(page, heldSurface);
  });

  it('a settled voice text-only turn with nothing held falls to loading', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'We open at nine.', channel: 'voice' })],
        userRequestPending: false,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'loading', key: 'loading' });
  });

  it('a settled turn that produced its own surface: the surface wins, text never shown', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'Here is the form you asked for.' })],
        surfaces: [{ id: 'fresh', responseId: 'r1' }],
        userRequestPending: false,
      }),
      null,
    );
    assert.strictEqual(page.kind, 'surface');
  });
});

describe('resolveStageView — sticky page (one transition per turn)', () => {
  const heldSurface: StageView = {
    kind: 'surface',
    key: 'surface:services:live',
    surfaceId: 'services',
  };

  it('a contentless pending turn holds the previous live page', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0' }), turn({ responseId: 'r1' })],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(page, heldSurface);
  });

  it('a new surface releases the hold; streaming text does NOT claim the page, it holds', () => {
    const bySurface = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' })],
        surfaces: [
          { id: 'services', responseId: 'r0' },
          { id: 'fresh', responseId: 'r1' },
        ],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(bySurface.kind, 'surface');
    assert.strictEqual(bySurface.kind === 'surface' ? bySurface.surfaceId : null, 'fresh');

    const byText = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'streaming…' })],
        surfaces: [{ id: 'services', responseId: 'r0' }],
        userRequestPending: true,
      }),
      heldSurface,
    );
    assert.strictEqual(byText, heldSurface);
  });

  it('a loading prev never holds', () => {
    const page = resolveStageView(
      input({ turns: [turn({ responseId: 'r1' })], userRequestPending: true }),
      { kind: 'loading', key: 'loading' },
    );
    assert.strictEqual(page.kind, 'loading');
  });
});

describe('resolveStageView — history', () => {
  it('history turn with a live surface resolves to an interactive surface view, keyed apart from the live head', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0', responseText: 'old answer' }), turn({ responseId: 'r1' })],
        selectedIndex: 0,
        surfaces: [{ id: 'live-surface', responseId: 'r0' }],
      }),
      null,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:live-surface:history-0',
      surfaceId: 'live-surface',
    });
  });

  it('history turn whose surface no longer exists falls back to its text', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0', responseText: 'old answer' }), turn({ responseId: 'r1' })],
        selectedIndex: 0,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'text', key: 'text:0', turnIndex: 0 });
  });

  it('history turn with no surface of its own shows the surface current AT THAT TURN — not the newest surface overall', () => {
    const page = resolveStageView(
      input({
        turns: [
          turn({ responseId: 'r0' }),
          turn({ responseId: 'r1', responseText: 'No, that field is optional.' }),
          turn({ responseId: 'r2' }),
        ],
        selectedIndex: 1,
        surfaces: [
          { id: 'formA', responseId: 'r0' },
          { id: 'tableB', responseId: 'r2' },
        ],
      }),
      null,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:formA:history-1',
      surfaceId: 'formA',
    });
  });

  it('history turn with neither a live surface nor text resolves to the empty (loading) view', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r0' }), turn({ responseId: 'r1' })],
        selectedIndex: 0,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'loading', key: 'loading' });
  });

  it('history does not apply the live head restore fallback: an identity-less turn never adopts an unrelated live surface, and the sticky page is ignored', () => {
    const page = resolveStageView(
      input({
        turns: [turn({}), turn({ responseId: 'r1' })],
        selectedIndex: 0,
        surfaces: [{ id: 'live-one', responseId: 'r1' }],
      }),
      { kind: 'surface', key: 'surface:live-one:live', surfaceId: 'live-one' },
    );
    assert.deepStrictEqual(page, { kind: 'loading', key: 'loading' });
  });

  it('selecting the live head index behaves as live head', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' })],
        selectedIndex: 0,
        surfaces: [{ id: 'mine', responseId: 'r1' }],
      }),
      null,
    );
    assert.strictEqual(page.kind, 'surface');
  });
});

describe('resolveStageView — streaming text never becomes the page while in flight', () => {
  it('a live-head pending turn with streaming text and no held page shows loading', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'Here is our pricing' })],
        userRequestPending: true,
      }),
      null,
    );
    assert.strictEqual(page.kind, 'loading');
  });

  it('once the run resolves, the same text mints the deferred text page', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: 'Here is our pricing' })],
        userRequestPending: false,
      }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'text', key: 'text:0', turnIndex: 0 });
  });
});

describe('findCarriedSurfaceId', () => {
  it('picks the nearest preceding surface, not the newest overall', () => {
    const turns = [
      turn({ responseId: 'r0' }),
      turn({ responseId: 'r1' }),
      turn({ responseId: 'r2' }),
    ];
    const surfaces = [
      { id: 'formA', responseId: 'r0' },
      { id: 'tableB', responseId: 'r2' },
    ];
    assert.strictEqual(findCarriedSurfaceId(turns, surfaces, 1), 'formA');
  });

  it('matches the turn at the given index itself when it has a surface', () => {
    const turns = [turn({ responseId: 'r0' })];
    const surfaces = [{ id: 'formA', responseId: 'r0' }];
    assert.strictEqual(findCarriedSurfaceId(turns, surfaces, 0), 'formA');
  });

  it('identity-less turns and surfaces never match each other', () => {
    const turns = [turn({ responseId: undefined }), turn({ responseId: undefined })];
    const surfaces = [{ id: 'restored-a' }, { id: 'restored-b' }];
    assert.strictEqual(findCarriedSurfaceId(turns, surfaces, 1), null);
  });

  it('returns null when no turn up to the index ever produced a live surface', () => {
    const turns = [turn({ responseId: 'r0' }), turn({ responseId: 'r1' })];
    const surfaces: StageViewInput['surfaces'] = [];
    assert.strictEqual(findCarriedSurfaceId(turns, surfaces, 1), null);
  });

  it('ignores a surface produced by a turn AFTER the given index', () => {
    const turns = [
      turn({ responseId: 'r0' }),
      turn({ responseId: 'r1' }),
      turn({ responseId: 'r2' }),
    ];
    const surfaces = [{ id: 'tableB', responseId: 'r2' }];
    assert.strictEqual(findCarriedSurfaceId(turns, surfaces, 1), null);
  });
});

describe('surface ownership — creator vs last toucher', () => {
  const surfaces = [{ id: 's1', responseId: 'r1', lastTouchedResponseId: 'r5' }];

  it('the re-rendering turn resolves to the surface it touched', () => {
    const page = resolveStageView(
      input({ turns: [turn({ responseId: 'r1' }), turn({ responseId: 'r5' })], surfaces }),
      null,
    );
    assert.deepStrictEqual(page, { kind: 'surface', key: 'surface:s1:live', surfaceId: 's1' });
  });

  it('the creating turn still resolves to it from history', () => {
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1' }), turn({ responseId: 'r5' })],
        surfaces,
        selectedIndex: 0,
      }),
      null,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:s1:history-0',
      surfaceId: 's1',
    });
  });

  it('findCarriedSurfaceId matches a turn that only touched the surface', () => {
    const carried = findCarriedSurfaceId([turn({ responseId: 'r5' })], surfaces, 0);
    assert.strictEqual(carried, 's1');
  });
});

describe('acknowledging a request without replacing the screen', () => {
  const surfaces = [{ id: 's1', responseId: 'r1', lastTouchedResponseId: 'r1' }];

  it('holds the screen unchanged while a request is in flight', () => {
    const page = resolveStageView(
      input({ turns: [turn({ responseId: 'r1' })], surfaces, userRequestPending: true }),
      null,
    );
    assert.deepStrictEqual(page, {
      kind: 'surface',
      key: 'surface:s1:live',
      surfaceId: 's1',
    });
  });

  it('REGRESSION: an empty new surface does not blank the held screen', () => {
    const held: StageView = { kind: 'surface', key: 'surface:s1:live', surfaceId: 's1' };
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r2' })],
        surfaces: [
          { id: 's1', responseId: 'r1', lastTouchedResponseId: 'r1', hasContent: true },
          { id: 's2', responseId: 'r2', lastTouchedResponseId: 'r2', hasContent: false },
        ],
        userRequestPending: true,
      }),
      held,
    );
    assert.strictEqual(page, held);
  });

  it('swaps to the new surface once its first component lands', () => {
    const held: StageView = { kind: 'surface', key: 'surface:s1:live', surfaceId: 's1' };
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r2' })],
        surfaces: [
          { id: 's1', responseId: 'r1', lastTouchedResponseId: 'r1', hasContent: true },
          { id: 's2', responseId: 'r2', lastTouchedResponseId: 'r2', hasContent: true },
        ],
        userRequestPending: true,
      }),
      held,
    );
    assert.deepStrictEqual(page, { kind: 'surface', key: 'surface:s2:live', surfaceId: 's2' });
    assert.strictEqual(
      isStageRunActive(true),
      true,
      'first content changes the page, not the response lifecycle or working chrome',
    );
  });

  it('restores the previous screen when a failed progressive surface is deleted', () => {
    const failedPartial: StageView = {
      kind: 'surface',
      key: 'surface:s2:live',
      surfaceId: 's2',
    };
    const page = resolveStageView(
      input({
        turns: [turn({ responseId: 'r2' })],
        surfaces: [{ id: 's1', responseId: 'r1', hasContent: true }],
        userRequestPending: true,
      }),
      failedPartial,
    );

    assert.deepStrictEqual(page, { kind: 'surface', key: 'surface:s1:live', surfaceId: 's1' });
    assert.strictEqual(isStageRunActive(true), true);
  });

  it('REGRESSION: the key does not change when pending flips', () => {
    const idle = resolveStageView(input({ turns: [turn({ responseId: 'r1' })], surfaces }), null);
    const busy = resolveStageView(
      input({ turns: [turn({ responseId: 'r1' })], surfaces, userRequestPending: true }),
      null,
    );
    assert.strictEqual(
      idle.key,
      busy.key,
      'a changing key remounts the surface — which erases exactly the input this work exists to protect',
    );
  });
});

describe('e2e — a re-render of the screen you are looking at', () => {
  // Live sequence: turn 1 rendered `s1`. Turn 2 arrives, runs, re-renders `s1`.
  // The visitor should never see the page leave and come back.
  const rendered = (lastTouched: string) => [
    { id: 's1', responseId: 'r1', lastTouchedResponseId: lastTouched },
  ];

  it('holds the surface page for the whole turn — never a flash to loading', () => {
    const turns = [turn({ responseId: 'r1' }), turn({ responseId: 'r2' })];

    const settled = resolveStageView(input({ turns: [turns[0]], surfaces: rendered('r1') }), null);
    assert.strictEqual(settled.kind, 'surface');

    // Turn 2 accepted; its render has NOT landed yet, so the surface still
    // points at r1.
    const inFlight = resolveStageView(
      input({ turns, surfaces: rendered('r1'), userRequestPending: true }),
      settled,
    );
    assert.strictEqual(
      inFlight.kind,
      'surface',
      'leaving the surface here is the full-screen refresh the visitor sees',
    );
    assert.strictEqual(inFlight.key, settled.key, 'a changed key remounts the whole page');

    // The render lands.
    const after = resolveStageView(input({ turns, surfaces: rendered('r2') }), inFlight);
    assert.strictEqual(after.kind, 'surface');
    assert.strictEqual(after.key, settled.key, 'same page, patched — not a new one');
  });

  it('also holds when a process part is active mid-turn', () => {
    const turns = [turn({ responseId: 'r1' }), turn({ responseId: 'r2' })];
    const settled = resolveStageView(input({ turns: [turns[0]], surfaces: rendered('r1') }), null);

    const working = resolveStageView(
      input({
        turns,
        surfaces: rendered('r1'),
        userRequestPending: true,
        processPartKey: 'call-9',
      }),
      settled,
    );
    assert.strictEqual(
      working.kind,
      'surface',
      'a process page here replaces the screen the visitor was reading',
    );
  });
});

describe('resolveStageView — terminal text policy and silent settled-empty', () => {
  it('a settled turn whose only content is terminal text owns the page as text', () => {
    const CREDITS_MESSAGE =
      'This agent has run out of credits. Please contact the agent owner to restore service.';
    const view = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: CREDITS_MESSAGE })],
      }),
      null,
    );
    assert.strictEqual(view.kind, 'text');
  });

  it('a settled turn with NO folded text and no surface resolves loading', () => {
    const view = resolveStageView(
      input({
        turns: [turn({ responseId: 'r1', responseText: '' })],
      }),
      null,
    );
    assert.strictEqual(view.kind, 'loading');
  });
});
