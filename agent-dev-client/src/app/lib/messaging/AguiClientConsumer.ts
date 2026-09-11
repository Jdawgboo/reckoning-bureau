/**
 * Client-side AG-UI consumer.
 *
 * Turns the native AG-UI event stream into the `AgentStreamContent` the store
 * already renders, using the SAME `AguiContentProjector` the server emits with
 * (vendored) — so the derived content is byte-identical to the legacy `content`
 * channel by construction, and the whole downstream pipeline (AgentConversation
 * reducer, grouping, components) is untouched.
 *
 * Three responsibilities the pure projector does not own:
 *  - responseId: each `AguiFrame` carries the platform run id; the projector
 *    stamps it onto every content item via `getResponseId`, matching the
 *    server's `{...content, responseId}` broadcast.
 *  - terminal signals: `RUN_FINISHED`/`RUN_ERROR` are synthesized into the
 *    `finish`/`error` signals the stream FSM gates on — mirroring how
 *    `consumeContentStream` derives them from the content stream lifecycle.
 *  - STATE events: `STATE_SNAPSHOT`/`STATE_DELTA` carry `uiState`, not content —
 *    they are routed to the injected `onState` sink (never the projector).
 *  - a2ui surface events: agentplace.a2ui.* CUSTOMs route to onSurface, stamped
 *    with the frame's responseId (never the projector).
 *  - observability tap: `onEvent`, when provided, sees every valid AG-UI
 *    event before routing (pure tap — it never changes what gets emitted).
 */

import { AguiContentProjector } from '../../../../vendor/agent-library/agui/content-projector.ts';
import { isAguiEvent, type AguiEvent } from '../../../../vendor/agent-library/agui/events.ts';
import type { AgentContent } from '../../../../vendor/agent-library/types/content.ts';
import type { AgentStreamContent } from '../services/websocket-client.types';
import type { FinishSignalContent, ErrorSignalContent } from '../../../../../shared';
import type { AguiFrame } from '../../../../../shared/ws-protocol.ts';
import { isA2uiEventName } from '../../../../vendor/agentplace-a2ui/event-names.ts';

export class AguiClientConsumer {
  readonly #emit: (content: AgentStreamContent) => void;
  readonly #onState: ((event: AguiEvent) => void) | undefined;
  readonly #onSurface: ((name: string, value: unknown, responseId?: string) => void) | undefined;
  readonly #onEvent: ((event: AguiEvent, responseId: string) => void) | undefined;
  #responseId: string | undefined;
  #projector: AguiContentProjector;

  constructor(
    emit: (content: AgentStreamContent) => void,
    onState?: (event: AguiEvent) => void,
    onSurface?: (name: string, value: unknown, responseId?: string) => void,
    onEvent?: (event: AguiEvent, responseId: string) => void,
  ) {
    this.#emit = emit;
    this.#onState = onState;
    this.#onSurface = onSurface;
    this.#onEvent = onEvent;
    this.#projector = this.#buildProjector();
  }

  /**
   * Drop all per-run state. Called per session so a projector's tool-metadata
   * map never leaks across sessions (matches a fresh content subscription).
   */
  reset(): void {
    this.#responseId = undefined;
    this.#projector = this.#buildProjector();
  }

  consume(frame: AguiFrame): void {
    this.#responseId = frame.responseId;
    const event = frame.event;
    if (!isAguiEvent(event)) {
      return;
    }
    this.#onEvent?.(event, frame.responseId);

    if (event.type === 'RUN_FINISHED') {
      this.#emit(this.#finishSignal());
      return;
    }
    if (event.type === 'RUN_ERROR') {
      this.#emit(this.#errorSignal(event.message));
      return;
    }
    if (event.type === 'STATE_SNAPSHOT' || event.type === 'STATE_DELTA') {
      this.#onState?.(event);
      return;
    }

    if (event.type === 'CUSTOM' && isA2uiEventName(event.name)) {
      this.#onSurface?.(event.name, event.value, this.#responseId);
      return;
    }

    this.#projector.handle(event);
  }

  #buildProjector(): AguiContentProjector {
    const sink = {
      isEnded: () => false,
      // Re-stamp with the frame's platform responseId — envelope contents carry
      // the library's internal run id, and turn grouping keys on the platform id
      // (the legacy content channel enriched every item the same way).
      append: (content: AgentContent) =>
        this.#emit(this.#responseId ? { ...content, responseId: this.#responseId } : content),
      endStream: () => {},
    };
    return new AguiContentProjector(sink, () => this.#responseId);
  }

  #finishSignal(): FinishSignalContent {
    return { type: 'finish', messageId: 'finish', responseId: this.#responseId };
  }

  #errorSignal(message: string): ErrorSignalContent {
    return { type: 'error', messageId: 'error', error: message, responseId: this.#responseId };
  }
}
