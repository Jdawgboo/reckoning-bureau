import type { RealtimeSocket } from '../openai-realtime-socket.ts';

/**
 * In-process fake of the OpenAI Realtime peer (same philosophy as the agent
 * harness's ScriptedModel): records every event the gateway sends, lets tests
 * emit scripted server events, and exposes close tracking.
 */
export class ScriptedRealtimePeer implements RealtimeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  #closeCode: number | undefined;
  #closeReason: string | undefined;
  #eventHandlers: Array<(event: Record<string, unknown>) => void> = [];
  #closeHandlers: Array<(code?: number, reason?: string) => void> = [];
  #errorHandlers: Array<(error: Error) => void> = [];

  send(event: Record<string, unknown>): void {
    this.sent.push(event);
  }

  onEvent(handler: (event: Record<string, unknown>) => void): void {
    this.#eventHandlers.push(handler);
  }

  /**
   * Late registration fires immediately, the way a real socket's teardown is
   * consumed: session setup awaits round trips, so a handler is routinely added
   * after the peer has already gone.
   */
  onClose(handler: (code?: number, reason?: string) => void): void {
    if (this.closed) {
      handler(this.#closeCode, this.#closeReason);
      return;
    }
    this.#closeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.#errorHandlers.push(handler);
  }

  /** Closes the peer. `code`/`reason` script a provider-initiated close frame. */
  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#closeCode = code;
    this.#closeReason = reason;
    for (const handler of this.#closeHandlers) {
      handler(code, reason);
    }
  }

  /** Emit a scripted server event to the gateway. */
  emit(event: Record<string, unknown>): void {
    for (const handler of this.#eventHandlers) {
      handler(event);
    }
  }

  /** Simulate a post-open transport failure (the real socket follows it with a close). */
  emitError(error: Error): void {
    for (const handler of this.#errorHandlers) {
      handler(error);
    }
  }

  /** Convenience: emit a completed response containing one function call. */
  emitFunctionCall(name: string, args: Record<string, unknown>, callId = 'call-1'): void {
    this.emit({
      type: 'response.done',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            status: 'completed',
            name,
            call_id: callId,
            arguments: JSON.stringify(args),
          },
        ],
      },
    });
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((event) => event.type === type);
  }

  /**
   * Frames selected by which top-level key they carry, for providers that
   * discriminate on the key rather than on a `type` field — Gemini Live's
   * client frames are `{setup|clientContent|realtimeInput|toolResponse}`.
   */
  sentWithKey(key: string): Record<string, unknown>[] {
    return this.sent.filter((event) => key in event);
  }
}
