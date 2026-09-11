import assert from 'node:assert';
import { describe, it } from 'node:test';
import type {
  IStateNode,
  SessionPresentationLocale,
  StateChangeEvent,
} from '../bl/agent/agent-library.ts';
import { SessionLocaleController } from './session-locale.controller.ts';

class LocaleNode implements IStateNode<SessionPresentationLocale> {
  readonly path = '/sessions/session-1/presentationLocale';
  readonly name = 'presentationLocale';
  data: SessionPresentationLocale | null;
  loaded = false;
  loading = false;
  readonly children = new Map<string, IStateNode>();
  readonly writes: SessionPresentationLocale[] = [];
  #subscriber: ((event: StateChangeEvent) => void) | null = null;

  constructor(initial: SessionPresentationLocale | null) {
    this.data = initial;
  }

  async load(): Promise<void> {
    this.loaded = true;
  }

  async set(value: SessionPresentationLocale): Promise<void> {
    await Promise.resolve();
    this.data = structuredClone(value);
    this.loaded = true;
    this.writes.push(structuredClone(value));
  }

  async delete(): Promise<void> {
    this.data = null;
  }

  async append(): Promise<number> {
    return 0;
  }

  at(): IStateNode {
    throw new Error('not implemented');
  }

  subscribe(handler: (event: StateChangeEvent) => void): () => void;
  subscribe(_pattern: string, handler: (event: StateChangeEvent) => void): () => void;
  subscribe(
    patternOrHandler: string | ((event: StateChangeEvent) => void),
    maybeHandler?: (event: StateChangeEvent) => void,
  ): () => void {
    this.#subscriber =
      typeof patternOrHandler === 'function' ? patternOrHandler : (maybeHandler ?? null);
    return () => {
      this.#subscriber = null;
    };
  }

  emit(value: SessionPresentationLocale): void {
    this.#subscriber?.({
      path: this.path,
      change: 'set',
      value,
      source: 'remote',
      timestamp: new Date().toISOString(),
    });
  }
}

function controller() {
  return new SessionLocaleController({ sourceLocale: 'en' });
}

describe('SessionLocaleController', () => {
  it('initializes and persists the canonical source default as one whole record', async () => {
    const locale = controller();
    const node = new LocaleNode(null);
    const current = await locale.bind(node);
    assert.deepStrictEqual(current, {
      messageLocale: 'en',
      formatLocale: 'en',
      source: 'default',
      revision: 0,
    });
    assert.deepStrictEqual(node.writes, [current]);
  });

  it('rehydrates durable desired locale before the next proposal', async () => {
    const stored: SessionPresentationLocale = {
      messageLocale: 'fr',
      formatLocale: 'fr-CA',
      source: 'explicit',
      revision: 7,
    };
    const locale = controller();
    const node = new LocaleNode(stored);
    assert.deepStrictEqual(await locale.bind(node), stored);
    const changed = await locale.propose('de-DE', 'explicit');
    assert.deepStrictEqual(changed, {
      messageLocale: 'de-DE',
      formatLocale: 'de-DE',
      source: 'explicit',
      revision: 8,
    });
  });

  it('uses navigator only to initialize a default session', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    assert.deepStrictEqual(await locale.propose('fr-fr', 'navigator'), {
      messageLocale: 'fr-FR',
      formatLocale: 'fr-FR',
      source: 'navigator',
      revision: 1,
    });
    assert.strictEqual((await locale.propose('de', 'navigator')).messageLocale, 'fr-FR');
  });

  it('commits clear conversational evidence immediately over navigator and prior conversation', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    await locale.propose('en', 'navigator');

    const firstConversation = await locale.propose('pl', 'conversation');
    assert.deepStrictEqual(firstConversation, {
      messageLocale: 'pl',
      formatLocale: 'pl',
      source: 'conversation',
      revision: 2,
    });

    const nextConversation = await locale.propose('uk', 'conversation');
    assert.deepStrictEqual(nextConversation, {
      messageLocale: 'uk',
      formatLocale: 'uk',
      source: 'conversation',
      revision: 3,
    });
  });

  it('records conversation authority when it confirms the navigator locale', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    await locale.propose('fr', 'navigator');

    const committed = await locale.propose('fr', 'conversation');
    assert.deepStrictEqual(committed, {
      messageLocale: 'fr',
      formatLocale: 'fr',
      source: 'conversation',
      revision: 2,
    });
  });

  it('does not downgrade explicit authority when conversation confirms the same locale', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    const explicit = await locale.propose('fr', 'explicit');

    assert.deepStrictEqual(await locale.propose('fr', 'conversation'), explicit);
  });

  it('keeps an explicit visitor preference locked against later conversation evidence', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    const explicit = await locale.propose('en', 'explicit');

    assert.deepStrictEqual(await locale.propose('pl', 'conversation'), explicit);
    assert.deepStrictEqual(await locale.propose('de', 'navigator'), explicit);
  });

  it('allows a later explicit request to replace the prior visitor preference', async () => {
    const locale = controller();
    await locale.bind(new LocaleNode(null));
    await locale.propose('en', 'explicit');

    assert.deepStrictEqual(await locale.propose('fr-CA', 'explicit'), {
      messageLocale: 'fr-CA',
      formatLocale: 'fr-CA',
      source: 'explicit',
      revision: 2,
    });
  });

  it('serializes concurrent proposals and keeps revisions monotonic', async () => {
    const locale = controller();
    const node = new LocaleNode(null);
    await locale.bind(node);
    const results = await Promise.all([
      locale.propose('fr', 'explicit'),
      locale.propose('de', 'explicit'),
      locale.propose('pl', 'explicit'),
    ]);
    assert.deepStrictEqual(
      results.map((result) => result.revision),
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      node.writes.map((write) => write.revision),
      [0, 1, 2, 3],
    );
  });

  it('keeps full formatting locale while selecting a compatible message locale', async () => {
    const locale = new SessionLocaleController({
      sourceLocale: 'en',
      selectMessageLocale: (formatLocale) => (formatLocale === 'fr-CA' ? 'fr' : formatLocale),
    });
    await locale.bind(new LocaleNode(null));
    assert.deepStrictEqual(await locale.propose('fr-CA', 'explicit'), {
      messageLocale: 'fr',
      formatLocale: 'fr-CA',
      source: 'explicit',
      revision: 1,
    });
  });

  it('rejects invalid tags and ignores conflicting non-newer remote records', async () => {
    const locale = controller();
    const node = new LocaleNode(null);
    await locale.bind(node);
    await assert.rejects(() => locale.propose('not_a_locale', 'explicit'));
    await locale.propose('fr', 'explicit');
    node.emit({
      messageLocale: 'de',
      formatLocale: 'de',
      source: 'explicit',
      revision: 1,
    });
    assert.strictEqual(locale.current.messageLocale, 'fr');
  });
});
