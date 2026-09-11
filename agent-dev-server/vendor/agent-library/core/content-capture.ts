import {
  contentReducer,
  createInitialContentState,
  type ContentState,
} from '../kernel/utils/content-reducer.ts';
import { ContentType, type AgentContent, type ComponentContent } from '../types/content.ts';
import type { UiSink } from '../kernel/ui-sink.ts';
import { generateShortId } from '../types/id.ts';

/** The in-progress assistant text message a run was streaming when it ended. */
export interface PendingAssistantText {
  messageId: string;
  text: string;
  responseId?: string;
}

/**
 * Wraps a UiSink: forwards every appended item unchanged to the live stream
 * while reducing the stream into finalized content items keyed by messageId.
 *
 * This lets durable UI history (CONTENT#) be captured with the same identities
 * the live stream uses, so committed items and replayed deltas reconcile by id
 * on reload. The wrapper also pins messageId/responseId at the produce-side
 * append point so captured ids provably equal live-stream ids.
 */
export class ContentCapture implements UiSink<AgentContent> {
  readonly #inner: UiSink<AgentContent>;
  readonly #getResponseId: () => string | undefined;
  #state: ContentState = createInitialContentState();
  readonly #emitted = new Set<string>();

  constructor(inner: UiSink<AgentContent>, getResponseId: () => string | undefined) {
    this.#inner = inner;
    this.#getResponseId = getResponseId;
  }

  isEnded(): boolean {
    return this.#inner.isEnded();
  }

  endStream(): void {
    this.#inner.endStream();
  }

  append(content: AgentContent): void {
    if (!content.messageId) {
      content.messageId = generateShortId(8);
    }
    if (!content.responseId) {
      content.responseId = this.#getResponseId();
    }
    this.#inner.append(content);
    this.#state = contentReducer(this.#state, { type: 'append', content });
  }

  /** Items finalized since the last take — call at each model-step boundary. */
  takeFinalized(): AgentContent[] {
    return this.#take(isFinalizedContent);
  }

  /** All not-yet-taken items regardless of state — call once at terminal. */
  takeAll(): AgentContent[] {
    return this.#take(() => true);
  }

  /**
   * The current unfinalized assistant text message — accumulated deltas not
   * yet taken by `takeFinalized`/`takeAll` — or null when the last message
   * finalized cleanly. Run teardown reads this to durably persist partially
   * streamed output when a run ends without completing (abort/error).
   */
  pendingAssistantText(): PendingAssistantText | null {
    for (let i = this.#state.order.length - 1; i >= 0; i--) {
      const id = this.#state.order[i];
      if (this.#emitted.has(id)) {
        continue;
      }
      const item = this.#state.byId.get(id);
      if (!item || item.type !== ContentType.Text || item.isReasoning || item.role === 'user') {
        continue;
      }
      return { messageId: item.messageId, text: item.content, responseId: item.responseId };
    }
    return null;
  }

  #take(predicate: (item: AgentContent) => boolean): AgentContent[] {
    const out: AgentContent[] = [];
    for (const id of this.#state.order) {
      if (this.#emitted.has(id)) {
        continue;
      }
      const item = this.#state.byId.get(id);
      if (!item || !predicate(item)) {
        continue;
      }
      this.#emitted.add(id);
      out.push(item);
    }
    return out;
  }
}

/**
 * Text/reasoning is complete at its step boundary; a component is complete only
 * once its tool produced a result (or it is a non-streaming component, e.g.
 * Sources). The terminal flush (takeAll) ignores this and emits everything.
 */
function isFinalizedContent(item: AgentContent): boolean {
  if (item.type !== ContentType.Component) {
    return true;
  }
  const streaming = (item as ComponentContent).streaming;
  if (!streaming) {
    return true;
  }
  return streaming.state === 'output-available' || streaming.state === 'output-error';
}
