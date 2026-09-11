import type {
  IStateNode,
  SessionLocaleSource,
  SessionPresentationLocale,
} from '../bl/agent/agent-library.ts';
import { isRecord } from '../util/type-guards.ts';

export type SessionLocaleProposalSource = Exclude<SessionLocaleSource, 'default'>;
export type MessageLocaleSelector = (formatLocale: string) => string;

const SOURCE_PRIORITY: Readonly<Record<SessionLocaleSource, number>> = {
  default: 0,
  navigator: 1,
  conversation: 2,
  explicit: 3,
};

export class SessionLocaleController {
  readonly #sourceLocale: string;
  readonly #selectMessageLocale: MessageLocaleSelector;
  #current: SessionPresentationLocale;
  #node: IStateNode<SessionPresentationLocale> | null = null;
  #unsubscribe: (() => void) | null = null;
  #transitionTail: Promise<void> = Promise.resolve();

  constructor(params: {
    sourceLocale: string;
    selectMessageLocale?: MessageLocaleSelector;
  }) {
    this.#sourceLocale = normalizeLocale(params.sourceLocale);
    this.#selectMessageLocale = params.selectMessageLocale ?? ((locale) => locale);
    this.#current = {
      messageLocale: this.#sourceLocale,
      formatLocale: this.#sourceLocale,
      source: 'default',
      revision: 0,
    };
  }

  get current(): SessionPresentationLocale {
    return { ...this.#current };
  }

  bind(node: IStateNode<SessionPresentationLocale>): Promise<SessionPresentationLocale> {
    return this.#serialize(async () => {
      this.#unsubscribe?.();
      this.#node = node;
      await node.load();
      const stored = readPresentationLocale(node.data);
      if (stored) {
        this.#current = stored;
      } else {
        await node.set(this.#current);
      }
      this.#unsubscribe = node.subscribe((event) => {
        if (event.change === 'delete') {
          return;
        }
        const remote = readPresentationLocale(event.value);
        if (remote && remote.revision > this.#current.revision) {
          this.#current = remote;
        }
      });
      return this.current;
    });
  }

  propose(locale: string, source: SessionLocaleProposalSource): Promise<SessionPresentationLocale> {
    return this.#serialize(async () => {
      const formatLocale = normalizeLocale(locale);
      const messageLocale = normalizeLocale(this.#selectMessageLocale(formatLocale));

      if (source === 'navigator') {
        if (this.#current.source !== 'default') {
          return this.current;
        }
        return this.#commit({ messageLocale, formatLocale, source });
      }

      if (source === 'conversation' && this.#current.source === 'explicit') {
        return this.current;
      }

      if (sameLocale(this.#current, { messageLocale, formatLocale })) {
        if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[this.#current.source]) {
          return this.#commit({ messageLocale, formatLocale, source });
        }
        return this.current;
      }
      return this.#commit({ messageLocale, formatLocale, source });
    });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#node = null;
  }

  async #commit(
    next: Omit<SessionPresentationLocale, 'revision'>,
  ): Promise<SessionPresentationLocale> {
    if (
      this.#current.messageLocale === next.messageLocale &&
      this.#current.formatLocale === next.formatLocale &&
      this.#current.source === next.source
    ) {
      return this.current;
    }
    const committed = { ...next, revision: this.#current.revision + 1 };
    await this.#node?.set(committed);
    this.#current = committed;
    return this.current;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transitionTail.then(operation);
    this.#transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function readPresentationLocale(value: unknown): SessionPresentationLocale | null {
  if (
    !isRecord(value) ||
    typeof value['messageLocale'] !== 'string' ||
    typeof value['formatLocale'] !== 'string' ||
    !isLocaleSource(value['source']) ||
    typeof value['revision'] !== 'number' ||
    !Number.isSafeInteger(value['revision']) ||
    value['revision'] < 0
  ) {
    return null;
  }
  try {
    const messageLocale = normalizeLocale(value['messageLocale']);
    const formatLocale = normalizeLocale(value['formatLocale']);
    if (messageLocale !== value['messageLocale'] || formatLocale !== value['formatLocale']) {
      return null;
    }
    return {
      messageLocale,
      formatLocale,
      source: value['source'],
      revision: value['revision'],
    };
  } catch {
    return null;
  }
}

function isLocaleSource(value: unknown): value is SessionLocaleSource {
  return (
    value === 'default' || value === 'navigator' || value === 'conversation' || value === 'explicit'
  );
}

function normalizeLocale(locale: string): string {
  try {
    const canonical = Intl.getCanonicalLocales(locale.trim());
    if (canonical.length !== 1) {
      throw new Error('Expected one locale.');
    }
    return canonical[0];
  } catch {
    throw new Error('Invalid session presentation locale.');
  }
}

function sameLocale(
  current: SessionPresentationLocale,
  next: Pick<SessionPresentationLocale, 'messageLocale' | 'formatLocale'>,
): boolean {
  return current.messageLocale === next.messageLocale && current.formatLocale === next.formatLocale;
}
