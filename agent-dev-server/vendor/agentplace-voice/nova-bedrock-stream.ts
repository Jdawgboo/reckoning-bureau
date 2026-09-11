/**
 * Transport for AWS Nova Sonic — and the reason it is not a `RealtimeSocket`
 * (`openai-realtime-socket.ts`), which every other provider here uses.
 *
 * OpenAI and Gemini Live are both WebSockets: a duplex channel where frames are
 * pushed in both directions and a handler fires per inbound frame. Nova Sonic is
 * `InvokeModelWithBidirectionalStream` — an AWS event-stream over HTTP/2 whose
 * request body *is an async iterable the SDK pulls from*, and whose response is
 * an async iterable the caller pulls from. Nothing pushes. Modelling that as a
 * socket would mean inventing a push loop on both sides, and this library exists
 * because inventing what a provider does not do is how the last one broke.
 *
 * So the port is shaped like what Nova actually is: a queue you write to and a
 * sequence you iterate.
 *
 * ## Why the AWS SDK is not imported here
 *
 * `agentplace-voice` depends on `ws` and nothing else, and it is not installed
 * from a registry — it is copied wholesale into the servers that use it, this
 * one included. Adding `@aws-sdk/client-bedrock-runtime` — several megabytes,
 * transitively enormous — to a library that travels by copy is not a
 * dependency, it is a tax on every consumer whether or not they ever place a
 * Nova call.
 *
 * The split that avoids it is the same one the rest of this library already
 * makes between transport and semantics, moved one notch further out. Everything
 * that is *protocol* — the push-driven request queue, event-stream framing, JSON
 * encode/decode, ordering — lives here and is tested here. The only genuinely
 * AWS-shaped part is constructing the client and the command, which is five
 * lines, needs credentials, and belongs to the consumer that already has both.
 * That part enters through {@link NovaStreamOpener}, a function type describing
 * the SDK call structurally so no `@aws-sdk` symbol — not even a type — is
 * referenced from this package.
 *
 * A consumer wires it up like this:
 *
 * ```ts
 * import {
 *   BedrockRuntimeClient,
 *   InvokeModelWithBidirectionalStreamCommand,
 * } from '@aws-sdk/client-bedrock-runtime';
 *
 * const client = new BedrockRuntimeClient({ region, credentials });
 * const opener: NovaStreamOpener = async ({ modelId, body }) => {
 *   const response = await client.send(
 *     new InvokeModelWithBidirectionalStreamCommand({ modelId, body }),
 *   );
 *   return response.body ?? [];
 * };
 * ```
 *
 * Credentials are the consumer's problem for a second reason: on Bedrock,
 * bidirectional streaming accepts **SigV4 only**. A Bedrock API key is rejected
 * outright, so the credential is an assumed-role session whose expiry
 * independently bounds the stream — a fact the consumer holding the role can act
 * on and this library cannot.
 */

/**
 * One Bedrock event-stream chunk, in the SDK's shape.
 *
 * Declared structurally rather than imported so this file stays free of
 * `@aws-sdk`; it is the subset of `InvokeModelWithBidirectionalStreamOutput`
 * that carries payload bytes.
 */
export interface NovaStreamChunk {
  chunk?: { bytes?: Uint8Array };
}

/**
 * Opens one Bedrock bidirectional stream. The consumer supplies this; see the
 * file header for the five lines it takes.
 *
 * `body` must be handed to the SDK unconsumed — it is a live queue, and the SDK
 * pulling from it is what paces the request. The plain-`Iterable` half of the
 * return type is what lets the documented `response.body ?? []` fallback compile
 * without the consumer inventing an empty async generator.
 */
export type NovaStreamOpener = (request: {
  modelId: string;
  body: AsyncIterable<NovaStreamChunk>;
}) => Promise<AsyncIterable<NovaStreamChunk> | Iterable<NovaStreamChunk>>;

/**
 * One live Nova Sonic bidirectional stream.
 *
 * Frames are the wire shape — `{ event: { sessionStart: … } }` — in both
 * directions, deliberately: a test double implementing this port records exactly
 * what Nova would have received, rather than one convenience layer away from it.
 */
export interface NovaBidirectionalStream {
  /** Queue one client frame. Ignored once {@link close} has been called. */
  send(frame: Record<string, unknown>): void;
  /**
   * Server frames in arrival order. Consume once: the underlying HTTP/2
   * response is a single-pass stream.
   *
   * Completion means the stream ended; a throw means it failed. There is no
   * separate close or error channel because the iterable already has both.
   */
  events(): AsyncIterable<Record<string, unknown>>;
  /** Stop writing. The server drains what is queued and the iterable completes. */
  close(): void;
}

/**
 * A {@link NovaBidirectionalStream} backed by a Bedrock stream the consumer
 * opens.
 *
 * Synchronous on purpose. The SDK's `send` does not resolve until it can begin
 * writing the request body, so opening the stream *before* anything is queued
 * risks blocking on an empty queue; and the adapter needs to write
 * `sessionStart` / `promptStart` / the system prompt the instant it is
 * constructed. Returning immediately and opening lazily on the first
 * {@link NovaBidirectionalStream.events} call gives the SDK a non-empty queue to
 * pull from, and surfaces a rejected handshake through the event stream — where
 * every other stream failure already arrives — instead of a second error path.
 */
export function openNovaBedrockStream(params: {
  opener: NovaStreamOpener;
  modelId: string;
}): NovaBidirectionalStream {
  const outgoing = new FrameQueue();
  return {
    send: (frame) => outgoing.push(frame),
    close: () => outgoing.finish(),
    events: async function* events() {
      const responses = await params.opener({ modelId: params.modelId, body: outgoing.chunks() });
      for await (const item of responses) {
        const bytes = item.chunk?.bytes;
        if (!bytes) {
          continue;
        }
        // An unparseable payload throws, ending the stream with the parse error
        // rather than skipping a frame the adapter needed and cannot know it
        // missed.
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          yield parsed as Record<string, unknown>;
        }
      }
    },
  };
}

/**
 * The request body: frames pushed by the adapter, pulled by the SDK.
 *
 * A plain array plus a wake-up promise rather than a stream library, because the
 * whole contract is "yield what is queued, then wait" and the AWS SDK asks for
 * nothing more than an async iterable.
 */
class FrameQueue {
  #chunks: NovaStreamChunk[] = [];
  #wake: (() => void) | null = null;
  #finished = false;

  push(frame: Record<string, unknown>): void {
    if (this.#finished) {
      return;
    }
    this.#chunks.push({ chunk: { bytes: new TextEncoder().encode(JSON.stringify(frame)) } });
    this.#release();
  }

  finish(): void {
    this.#finished = true;
    this.#release();
  }

  async *chunks(): AsyncIterable<NovaStreamChunk> {
    while (true) {
      const next = this.#chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#finished) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #release(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
