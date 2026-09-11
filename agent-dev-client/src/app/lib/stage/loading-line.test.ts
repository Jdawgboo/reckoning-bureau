import assert from 'node:assert';
import { describe, it } from 'node:test';
import { resolveLoadingLine, type LoadingLineInput } from './loading-line.ts';

const copy = {
  couldNotConnect: "Couldn't connect. Tap to retry.",
  connecting: 'Connecting…',
  gettingReady: 'Getting ready…',
  thinking: 'Thinking',
  pageLoadFailed: 'Something went wrong loading this page. Tap to retry.',
};

const base: LoadingLineInput = {
  connectionStatus: 'connected',
  isReady: true,
  initError: false,
  runInFlight: false,
  narrationLine: '',
  settledEmpty: false,
  terminalText: null,
};

describe('resolveLoadingLine', () => {
  const rows: Array<[string, Partial<LoadingLineInput>, string, string]> = [
    [
      'socket down',
      { connectionStatus: 'disconnected', isReady: false },
      'connecting',
      'Connecting…',
    ],
    [
      'socket connecting',
      { connectionStatus: 'connecting', isReady: false },
      'connecting',
      'Connecting…',
    ],
    ['reconnecting mid-session', { connectionStatus: 'reconnecting' }, 'connecting', 'Connecting…'],
    ['connected, session not ready', { isReady: false }, 'preparing', 'Getting ready…'],
    [
      'init failed',
      { isReady: false, initError: true },
      'init-failed',
      "Couldn't connect. Tap to retry.",
    ],
    [
      'run in flight with narration',
      { runInFlight: true, narrationLine: 'Looking that up' },
      'working',
      'Looking that up',
    ],
    ['run in flight, no narration yet', { runInFlight: true }, 'working', 'Thinking'],
    [
      'settled with terminal text',
      {
        settledEmpty: true,
        terminalText:
          'This agent has run out of credits. Please contact the agent owner to restore service.',
      },
      'terminal',
      'This agent has run out of credits. Please contact the agent owner to restore service.',
    ],
    [
      'settled, silent',
      { settledEmpty: true },
      'stuck',
      'Something went wrong loading this page. Tap to retry.',
    ],
  ];
  for (const [name, patch, kind, text] of rows) {
    it(name, () => {
      const line = resolveLoadingLine({ ...base, ...patch }, copy);
      assert.strictEqual(line.kind, kind);
      assert.strictEqual(line.text, text);
    });
  }

  it('precedence: init-failed outranks connecting; terminal beats stuck', () => {
    assert.strictEqual(
      resolveLoadingLine(
        {
          ...base,
          connectionStatus: 'disconnected',
          isReady: false,
          initError: true,
        },
        copy,
      ).kind,
      'init-failed',
    );
    assert.strictEqual(
      resolveLoadingLine(
        {
          ...base,
          connectionStatus: 'disconnected',
          isReady: false,
          initError: false,
        },
        copy,
      ).kind,
      'connecting',
    );
    assert.strictEqual(
      resolveLoadingLine({ ...base, settledEmpty: true, terminalText: 'x' }, copy).kind,
      'terminal',
    );
  });

  it('the silent-shimmer state is unreachable: every input combination yields a line', () => {
    const statuses = ['disconnected', 'connecting', 'connected', 'reconnecting'] as const;
    for (const connectionStatus of statuses) {
      for (const isReady of [true, false]) {
        for (const initError of [true, false]) {
          for (const runInFlight of [true, false]) {
            for (const settledEmpty of [true, false]) {
              for (const terminalText of [null, 'msg']) {
                const line = resolveLoadingLine(
                  {
                    ...base,
                    connectionStatus,
                    isReady,
                    initError,
                    runInFlight,
                    settledEmpty,
                    terminalText,
                  },
                  copy,
                );
                assert.ok(
                  line.text.length > 0,
                  JSON.stringify({
                    connectionStatus,
                    isReady,
                    initError,
                    runInFlight,
                    settledEmpty,
                    terminalText,
                  }),
                );
              }
            }
          }
        }
      }
    }
  });
});
