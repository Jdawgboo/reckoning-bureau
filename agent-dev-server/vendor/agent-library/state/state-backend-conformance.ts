import assert from 'node:assert';
import type { StateBackend } from './types.ts';
import type { ConversationMessage } from '../sessions/types.ts';
import { SessionManager } from '../sessions/session-manager.ts';
import { StateTree } from './state-tree.ts';
import { createCheckpointMessage } from '../sessions/checkpoint.ts';

/**
 * One behavioural contract, executed against EVERY `StateBackend`.
 *
 * The lab substitutes its own backend for production's. Historically that
 * substitution was verified by nothing, and it drifted: `InMemoryStateBackend`
 * returned snapshot entries raw while `DirectStateBackend` wraps each one as
 * `{ role, timestamp, data: msg }`. Every scenario that loaded from a snapshot
 * crashed reading `.data` — the harness was wrong, not the system, and no test
 * could say so.
 *
 * The same failure shape has now appeared four times in different components:
 * the middleware chain, `Agent` construction, `prepareStep` ordering, and this.
 * Each was closed by pinning the mirror against the real thing. This closes it
 * for backends, and generalises the rule: **a component the harness replaces
 * must be held to the same executable contract as the one it replaces.**
 *
 * Deliberately expressed through `SessionManager` rather than the backend's raw
 * methods. Callers reach backends through it, so the contract covers what
 * consumers actually depend on — snapshot assembly, WAL tail, checkpoint
 * visibility — instead of the storage primitives, which legitimately differ.
 *
 * Needs no infrastructure: any backend that can hold values in memory can run
 * this, which is the point. Verification does not require QA.
 */

export interface ConformanceCase {
  readonly name: string;
  readonly run: (makeBackend: () => StateBackend) => Promise<void>;
}

/**
 * A fresh session id per case.
 *
 * The contract must hold against a PERSISTENT store, not only against backends
 * that hand out an empty map per construction. Sharing one session id passed
 * against the in-memory backends and failed against real DynamoDB, where state
 * survives between cases — which was a flaw in this contract, not a divergence
 * in the database.
 */
let sessionCounter = 0;
function nextSession(): string {
  sessionCounter += 1;
  return `conformance-${sessionCounter}`;
}

function message(text: string): ConversationMessage {
  return {
    role: 'user',
    timestamp: '2026-07-27T00:00:00.000Z',
    data: { role: 'user', content: text },
  };
}

function textOf(entry: ConversationMessage): string {
  return JSON.stringify(entry.data ?? '');
}

async function managerWith(backend: StateBackend, session: string): Promise<SessionManager> {
  const manager = new SessionManager(new StateTree(backend));
  await manager.getOrCreate(session, 'web');
  return manager;
}

/**
 * Every case a backend must satisfy. Each states the consumer-visible behaviour
 * and why a divergence matters, so a failure names a real consequence rather
 * than an internal mismatch.
 */
export const STATE_BACKEND_CONFORMANCE: readonly ConformanceCase[] = [
  {
    name: 'appended messages load back in order',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      for (const text of ['one', 'two', 'three']) {
        await manager.appendMessage(SESSION, message(text));
      }

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      assert.deepStrictEqual(
        loaded.map((entry) => {
          const data = entry.data as { content?: unknown } | null;
          return typeof data?.content === 'string' ? data.content : null;
        }),
        ['one', 'two', 'three'],
        'WAL order is the conversation order — a reordering changes what the model reads',
      );
    },
  },
  {
    name: 'a snapshot replaces the messages it covers',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, message('collapsed'));
      await manager.writeSnapshot(SESSION, [
        { role: 'user', content: 'SUMMARY' },
      ] as unknown as Record<string, unknown>[]);

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      const texts = loaded.map(textOf);
      assert.ok(
        texts.some((t) => t.includes('SUMMARY')),
        'a backend that ignores its snapshot makes every compaction a no-op on reload',
      );
      assert.ok(
        !texts.some((t) => t.includes('collapsed')),
        'a message the snapshot collapsed must not reappear, or compaction never shrinks anything',
      );
    },
  },
  {
    name: 'snapshot entries arrive wrapped, with the model message under `data`',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, message('collapsed'));
      await manager.writeSnapshot(SESSION, [
        { role: 'user', content: 'SUMMARY' },
      ] as unknown as Record<string, unknown>[]);

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      for (const entry of loaded) {
        assert.notStrictEqual(
          entry.data,
          undefined,
          'callers read `.data` to get the ModelMessage. Returning snapshot entries raw makes ' +
            'the whole history undefined — the exact drift this contract was written for',
        );
        assert.ok(
          typeof entry.role === 'string',
          'a wrapped entry carries the role alongside its data',
        );
      }
    },
  },
  {
    name: 'messages appended after a snapshot still load',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, message('collapsed'));
      await manager.writeSnapshot(SESSION, [
        { role: 'user', content: 'SUMMARY' },
      ] as unknown as Record<string, unknown>[]);
      await manager.appendMessage(SESSION, message('after'));

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      assert.ok(
        loaded.map(textOf).some((t) => t.includes('after')),
        'dropping the WAL tail loses every message produced after the compaction — the ' +
          '"cross-turn cache broken" failure',
      );
    },
  },
  {
    name: 'checkpoint rows never reach the conversation',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, message('before'));
      await manager.appendMessage(SESSION, createCheckpointMessage(0, 'SUMMARY', [], {}, 'mid-1'));
      await manager.appendMessage(SESSION, message('after'));

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      assert.ok(
        !loaded.map(textOf).some((t) => t.includes('compaction-checkpoint')),
        'a checkpoint marker in the prompt is CHECKPOINT_MARKER_LEAK — the model reads ' +
          'bookkeeping as conversation',
      );
    },
  },
  {
    name: 'the latest compaction record is readable',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, createCheckpointMessage(0, 'first', [], {}, 'mid-1'));
      await manager.appendMessage(SESSION, createCheckpointMessage(0, 'second', [], {}, 'mid-2'));

      const record = await (await managerWith(backend, SESSION)).loadLatestCompactionRecord(
        SESSION,
      );
      assert.strictEqual(record?.summary, 'second', 'an older record describes a stale collapse');
      assert.strictEqual(record?.firstKeptMid, 'mid-2');
    },
  },
  {
    name: 'a round-trip preserves message content, whatever it does to key order',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);

      const original = { role: 'user' as const, content: 'ordered', extra: { b: 1, a: 2 } };
      await manager.appendMessage(SESSION, {
        role: 'user',
        timestamp: '2026-07-27T00:00:00.000Z',
        data: original,
      });

      const loaded = await (await managerWith(backend, SESSION)).loadConversation(SESSION);
      assert.deepStrictEqual(
        loaded[0]?.data,
        original,
        'every field must survive storage. This deliberately compares VALUES, not serialized ' +
          'bytes: an earlier version asserted byte-identity to protect the prompt cache, but ' +
          'probing Anthropic showed a reordered content block still scores a full cache read, ' +
          'so key order is not part of the cache key. DynamoDB does not preserve key order and ' +
          'does not need to — see the spec in docs/superpowers/specs/.',
      );
    },
  },
  {
    name: 'a session with no compaction reports no record',
    run: async (makeBackend) => {
      const backend = makeBackend();
      const SESSION = nextSession();
      const manager = await managerWith(backend, SESSION);
      await manager.appendMessage(SESSION, message('hello'));

      const record = await (await managerWith(backend, SESSION)).loadLatestCompactionRecord(
        SESSION,
      );
      assert.strictEqual(
        record,
        null,
        'inventing an empty record makes "never compacted" and ' +
          '"compacted with nothing to say" indistinguishable',
      );
    },
  },
];
